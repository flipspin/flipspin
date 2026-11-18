import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
const names = ['release', 'server-image', 'build', 'ci', 'keyfinder-wheels'];
const texts = Object.fromEntries(names.map(name => [name, readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8')]));
const workflows = Object.fromEntries(names.map(name => [name, parse(texts[name])]));
for (const name of names) {
  test(`${name}: read-only default and all external actions SHA pinned with version`, () => {
    assert.deepEqual(workflows[name].permissions, { contents: 'read' });
    for (const match of texts[name].matchAll(/uses: (.+)/g)) {
      if (match[1].startsWith('./')) continue;
      assert.match(match[1], /^[\w.-]+\/[\w.-]+@[a-f0-9]{40} # v\d+\.\d+\.\d+$/);
    }
  });
}
test('weekly GitHub Actions dependency updates', () => {
  const config = parse(readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8'));
  assert.ok(config.updates.some(item => item['package-ecosystem'] === 'github-actions' && item.schedule.interval === 'weekly'));
});
test('release path has no enabled cache, including implicit Rust cache', () => {
  for (const name of ['release', 'server-image', 'build', 'keyfinder-wheels']) {
    assert.doesNotMatch(texts[name], /actions\/cache|cache-from:|cache-to:/);
    for (const job of Object.values(workflows[name].jobs)) for (const step of job.steps ?? []) {
      if ('cache' in (step.with ?? {})) assert.equal(step.with.cache, false);
      if (step.uses?.startsWith('actions-rust-lang/')) assert.equal(step.with.cache, false);
      if (step.uses?.startsWith('docker/setup-buildx-action')) assert.equal(step.with['cache-binary'], false);
      if (step.uses?.startsWith('docker/setup-qemu-action')) assert.equal(step.with['cache-image'], false);
    }
  }
});
test('only publish promotes release tags; manual image tagging is sha-only', () => {
  assert.ok(!Object.values(texts).some(text => text.includes('latest=auto')));
  const image = workflows['server-image'].jobs.image;
  const push = image.steps.find(step => step.id === 'push');
  assert.match(push.with.outputs, /push-by-digest=true,name-canonical=true,push=true/);
  assert.equal(push.with.tags, undefined);
  assert.equal(push.with.platforms, 'linux/amd64,linux/arm64');
  assert.ok(image.steps.findIndex(step => step.name?.startsWith('Smoke test')) < image.steps.indexOf(push));
  assert.equal(workflows['server-image'].on.workflow_call.outputs.digest.value, '${{ jobs.image.outputs.digest }}');
  for (const [name, workflow] of Object.entries(workflows)) for (const [id, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (id === 'publish') continue;
      assert.doesNotMatch(step.run ?? '', /publish-release|gh release (?:create|upload|edit)|docker (?:push|tag)/);
      if (/imagetools create/.test(step.run ?? '')) {
        assert.equal(name, 'server-image');
        assert.equal(step.if, "github.event_name == 'workflow_dispatch'");
        assert.match(step.run, /--tag "\$IMAGE:sha-\$GITHUB_SHA" "\$IMAGE@\$DIGEST"/);
      }
      if (step.with?.push || /push=true/.test(step.with?.outputs ?? '')) assert.equal(step.with.tags, undefined);
    }
  }
});
test('one protected publish job uploads, attests, promotes then publishes', () => {
  const job = workflows.release.jobs.publish;
  assert.equal(job.environment, 'release');
  assert.deepEqual(job.needs, ['versions', 'image', 'installers', 'keyfinder', 'windows-smoke', 'ci-gate']);
  assert.equal(job.if, undefined); // All prerequisites must succeed before any release write.
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job.permissions['id-token'], 'write');
  assert.equal(job.permissions.attestations, 'write');
  assert.equal(job.concurrency.group, 'release-publish');
  const steps = job.steps;
  const prepare = steps.findIndex(s => s.run?.includes('publish-release.mjs prepare'));
  const attest = steps.map((s, i) => s.uses?.startsWith('actions/attest-build-provenance@') ? i : -1).filter(i => i >= 0);
  const finish = steps.findIndex(s => s.run?.includes('publish-release.mjs finish'));
  assert.equal(attest.length, 2);
  assert.ok(prepare < attest[0] && attest[1] < finish);
  assert.equal(steps[attest[0]].with['subject-path'], 'release-assets/*');
  assert.equal(steps[attest[1]].with['subject-digest'], '${{ env.IMAGE_DIGEST }}');
  assert.equal(steps[attest[1]].with['push-to-registry'], true);
  const wheels = steps.find(s => s.with?.pattern === 'keyfinder-*');
  assert.ok(steps.indexOf(wheels) < prepare);
  assert.equal(wheels.with.path, 'keyfinder');
  assert.notEqual(wheels.with['merge-multiple'], true); // prepare validates each OS artifact.
});
test('release publication requires successful CI on the same commit', () => {
  const gate = workflows.release.jobs['ci-gate'];
  assert.ok(gate, 'release must wait for the CI workflow');
  assert.equal(gate.permissions.actions, 'read');
  assert.equal(gate['continue-on-error'], undefined);
  assert.ok(gate['timeout-minutes'] > 0 && gate['timeout-minutes'] <= 60);
  const wait = gate.steps.find(step => step.run?.includes('gh run list'));
  assert.ok(wait);
  assert.equal(wait.env.SHA, '${{ github.sha }}');
  assert.equal(wait.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(wait.env.GH_REPO, '${{ github.repository }}');
  assert.match(wait.run, /--workflow ci.yml --commit "\$SHA"/);
  assert.match(wait.run, /--event push/);
  assert.match(wait.run, /status,conclusion/);
  assert.match(wait.run, /completed/);
  assert.match(wait.run, /success/);
  assert.match(wait.run, /exit 1/);
  assert.match(wait.run, /sleep \d+/);
  assert.match(wait.run, /SECONDS.*deadline/);
  assert.ok(workflows.release.jobs.publish.needs.includes('ci-gate'));
});
test('CI gate waits, fails closed and only accepts completed success', () => {
  const script = workflows.release.jobs['ci-gate'].steps.find(step => step.run?.includes('gh run list')).run;
  function run(responses, { apiFailure = false, expire = false } = {}) {
    // Bash functions stand in for the external API and clock. The workflow's
    // actual shell script runs unchanged, including its bounded timeout.
    const setup = `
      calls=0
      gh() {
        ${apiFailure ? 'return 33' : 'echo "$RESPONSES" | jq --argjson index "$calls" \'.[$index]\''}
      }
      sleep() { calls=$((calls + 1)); ${expire ? 'SECONDS=2700' : ':'}; }
    `;
    return spawnSync('bash', ['-euo', 'pipefail', '-c', setup + script], {
      encoding: 'utf8', env: { ...process.env, SHA: 'test-commit', RESPONSES: JSON.stringify(responses) },
      timeout: 5000,
    });
  }
  const success = [{ status: 'completed', conclusion: 'success' }];
  assert.equal(run([success]).status, 0);
  assert.equal(run([[], [{ status: 'in_progress', conclusion: '' }], success]).status, 0);
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', '']) {
    assert.equal(run([[{ status: 'completed', conclusion }]]).status, 1, conclusion);
  }
  const timeout = run([[]], { expire: true });
  assert.equal(timeout.status, 1);
  assert.match(timeout.stderr, /Timed out/);
  assert.equal(run([], { apiFailure: true }).status, 33);
});
test('reusable KeyFinder builds and smoke-tests every OS before uploading wheels', () => {
  const call = workflows.release.jobs.keyfinder;
  assert.equal(call.needs, 'versions');
  assert.equal(call.uses, './.github/workflows/keyfinder-wheels.yml');
  const workflow = workflows['keyfinder-wheels'];
  for (const trigger of ['workflow_call', 'workflow_dispatch', 'push']) assert.ok(trigger in workflow.on);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.on.push.tags, undefined);
  assert.equal(workflow.concurrency.group, 'keyfinder-wheels-${{ github.ref }}');
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
  assert.deepEqual(workflow.on.push.paths, ['helper/keyfinder/**', '.github/workflows/keyfinder-wheels.yml']);
  const job = workflow.jobs.wheels;
  assert.deepEqual(evaluate(job.strategy.matrix.os), ['macos-15', 'ubuntu-24.04', 'ubuntu-24.04-arm', 'windows-2022']);
  assert.equal(job['runs-on'], '${{ matrix.os }}');
  assert.equal(job.strategy['fail-fast'], false);
  assert.equal(job['continue-on-error'], undefined);
  const build = job.steps.find(s => s.uses?.startsWith('pypa/cibuildwheel@'));
  assert.equal(build.with['package-dir'], 'helper/keyfinder');
  assert.match(build.env.CIBW_ARCHS_LINUX, /ubuntu-24\.04-arm.*aarch64.*x86_64/);
  const smoke = build.env.CIBW_TEST_COMMAND;
  assert.match(smoke, /pip install "\{project\}\/helper\[analysis\]"/);
  assert.match(smoke, /import krobi_helper, krobi_keyfinder, onnxruntime/);
  assert.match(smoke, /assert importlib.util.find_spec\('torch'\) is None/);
  assert.match(smoke, /pytest "\{package\}\/tests"/);
  const upload = job.steps.find(s => s.uses?.startsWith('actions/upload-artifact@'));
  assert.ok(job.steps.indexOf(build) < job.steps.indexOf(upload));
  assert.equal(upload.with.name, 'keyfinder-${{ matrix.os }}');
  assert.equal(upload.with.path, 'wheelhouse/*.whl');
  assert.equal(upload.with['if-no-files-found'], 'error');
});
test('Windows smoke installs this run, checks desktop liveness and bundled backend identity, and keeps failure logs', () => {
  const job = workflows.release.jobs['windows-smoke'];
  assert.equal(job.needs, 'installers');
  assert.equal(job.if, "${{ !cancelled() && needs.installers.result != 'skipped' }}");
  assert.equal(job['runs-on'], 'windows-latest');
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job.env.RELEASE_TAG, '${{ github.ref_name }}');
  const download = job.steps.find(s => s.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with.pattern, 'krobi-windows-*');
  assert.equal(download.with.path, 'installers');
  assert.equal(download.with['run-id'], undefined);
  const smoke = job.steps.find(s => s.shell === 'pwsh');
  const run = smoke.run;
  assert.ok(job.steps.indexOf(download) < job.steps.indexOf(smoke));
  for (const pattern of [
    /\$installers.Count -ne 1/, /Start-Process.*\/S \/D=.*-Wait -PassThru/,
    /\$installer.ExitCode -ne 0/, /MainBinaryName/, /backend\\krobi-backend\.exe/,
    /Start-Sleep -Seconds 20/, /if \(\$app.HasExited\).*throw/,
    /--host 127\.0\.0\.1 --port 8000/, /AddSeconds\(120\)/,
    /http:\/\/127\.0\.0\.1:8000\/api\/status/, /\$status.app -cne 'krobi'/,
    /\$version = \$env:RELEASE_TAG.Substring\(1\)/, /\$status.version -cne \$version/,
    /finally \{\s+foreach \(\$process in @\(\$backend, \$app\)\)/, /taskkill \/PID \$process.Id \/T \/F/,
    /app\.flipspin\.desktop\\logs/, /Krobi\\logs/,
    /RedirectStandardOutput/, /RedirectStandardError/,
  ]) assert.match(run, pattern);
  const logs = job.steps.find(s => s.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(logs.if, 'failure()');
  assert.equal(logs.with.name, 'windows-smoke-logs');
  assert.equal(logs.with.path, '${{ runner.temp }}/windows-smoke-logs');
});
test('Apple secrets are environment-scoped and passed only for macOS; keychain hygiene retained', () => {
  assert.equal(workflows.release.jobs.installers.secrets, undefined);
  assert.equal(workflows.release.jobs.installers.with.release, true);
  const job = workflows.build.jobs.build;
  assert.match(job.environment, /inputs.release && inputs.platform == 'macos' && 'release'/);
  assert.equal(workflows.build.on.workflow_call.secrets, undefined);
  for (const step of job.steps) for (const [name, value] of Object.entries(step.env ?? {})) {
    if (name.startsWith('APPLE_')) assert.match(value, /inputs.platform == 'macos' && secrets\./);
  }
  assert.match(texts.build, /trap 'security delete-keychain/);
  assert.match(texts.build, /umask 077/);
  assert.match(texts.build, /keychain_password=\$\(openssl rand -hex 32\)/);
  for (const line of texts.build.split('\n').filter(line => /^\s+security /.test(line))) assert.match(line, />\/dev\/null 2>&1/);
});
test('verification follows publish, checks sums/provenance and pulls with isolated anonymous credentials', () => {
  const job = workflows.release.jobs.verify;
  assert.deepEqual(job.needs, ['versions', 'publish']);
  const run = job.steps.map(step => step.run ?? '').join('\n');
  for (const pattern of [/gh release download/, /sha256sum -c SHA256SUMS/, /gh attestation verify/, /--signer-workflow/, /DOCKER_CONFIG=.*anonymous-docker/, /docker pull "\$image"/, /\/api\/status/]) assert.match(run, pattern);
  assert.ok(!job.steps.some(step => step.uses?.includes('login-action')));
  assert.doesNotMatch(run, /release (delete|edit)/);
});

test('fresh-server and dev smoke select one root and assert HOME stays empty', () => {
  const smoke = workflows.ci.jobs.smoke.steps.find(step => step.run?.includes('SERVER_PID=$!')).run;
  assert.ok(smoke.includes('export FLIPSPIN_DATA_DIR="$DATA/state"'));
  assert.ok(smoke.includes('export HOME="$DATA/home"'));
  assert.ok(smoke.includes('find "$HOME" -mindepth 1'));
  const dev = workflows.ci.jobs.smoke.steps.find(step => step.run?.includes('make dev-check')).run;
  assert.ok(dev.includes('HOME="$DEV_HOME" make dev-check'));
  assert.ok(dev.includes('find "$DEV_HOME" -mindepth 1'));
});

test('release jobs keep independent failures visible', () => {
  assert.equal(workflows.release.concurrency['cancel-in-progress'], false);
  assert.equal(workflows.release.jobs.installers.strategy['fail-fast'], false);
  assert.equal(workflows.release.jobs.keyfinder.needs, 'versions');
});

// These policy expressions use the common JS/GitHub boolean and call subset.
function evaluate(expression, { privateRepo = false, tag = 'v1.2.3', event = 'push', macos = true, allPlatforms = true } = {}) {
  const github = { event: { repository: { private: privateRepo } }, ref_name: tag, event_name: event };
  return Function('github', 'inputs', 'fromJSON', 'contains', `return (${expression.slice(3, -3)})`)(
    github, { macos, all_platforms: allPlatforms }, JSON.parse, (value, part) => value.includes(part));
}

test('only private prereleases omit Mac installers, wheels and signing artifacts', () => {
  const release = workflows.release;
  const wheels = workflows['keyfinder-wheels'];
  for (const privateRepo of [false, true]) for (const tag of ['v1.2.3', 'v1.2.3-rc.5']) {
    const context = { privateRepo, tag };
    const skip = privateRepo && tag.includes('-');
    assert.deepEqual(evaluate(release.jobs.installers.strategy.matrix.platform, context),
      skip ? ['windows', 'linux'] : ['macos', 'windows', 'linux']);
    const macos = evaluate(release.jobs.keyfinder.with.macos, context);
    assert.equal(macos, !skip);
    assert.deepEqual(evaluate(wheels.jobs.wheels.strategy.matrix.os, { ...context, macos }),
      skip ? ['ubuntu-24.04', 'ubuntu-24.04-arm', 'windows-2022'] : ['macos-15', 'ubuntu-24.04', 'ubuntu-24.04-arm', 'windows-2022']);
    assert.equal(evaluate(release.jobs.publish.env.SKIP_MACOS, context), skip);
  }
  const signing = release.jobs.publish.steps.find(step => step.name === 'Download macOS signing status');
  assert.equal(signing.if, "${{ env.SKIP_MACOS != 'true' }}");
  const notes = release.jobs.publish.steps.find(step => step.name === 'Prepare release notes');
  assert.match(notes.run, /signing=not-built/);
  assert.match(notes.run, /if \[ "\$SKIP_MACOS" != 'true' \]; then signing=\$\(cat signing\/macos-signing.txt\); fi/);
  assert.equal(release.jobs.publish.concurrency['cancel-in-progress'], false);
});

test('KeyFinder branch pushes build Linux only; release calls and dispatch retain other platforms', () => {
  const workflow = workflows['keyfinder-wheels'];
  assert.equal(workflow.on.workflow_call.inputs.all_platforms.default, true);
  for (const trigger of ['workflow_call', 'workflow_dispatch']) {
    assert.equal(workflow.on[trigger].inputs.macos.default, true);
    assert.equal(workflow.on[trigger].inputs.macos.type, 'boolean');
    assert.deepEqual(evaluate(workflow.jobs.wheels.strategy.matrix.os, { event: trigger }),
      ['macos-15', 'ubuntu-24.04', 'ubuntu-24.04-arm', 'windows-2022']);
  }
  assert.deepEqual(evaluate(workflow.jobs.wheels.strategy.matrix.os, { event: 'push', macos: false, allPlatforms: false }),
    ['ubuntu-24.04', 'ubuntu-24.04-arm']);
});
