import { afterEach, expect, it } from 'vitest';
import i18n from '../i18n';
import { rowText } from './rowText';

afterEach(async () => { await i18n.changeLanguage('es'); });
it('keeps labels identical to i18next across language switches and interpolation', async () => {
  for (const language of ['es', 'en', 'es']) {
    await i18n.changeLanguage(language);
    expect(rowText("Add")).toBe(i18n.t("Add"));
    for (const key of ["Play {{title}}", "Add “{{title}}”", "Info for {{song}}", "Info · {{mood}}", "Another version in the nest ({{duration}})", "Adding · {{x}} %"]) {
      for (const title of ['Linen Spiral', '<>&\'" $t(Agregar) {{song}}', undefined]) {
        const values = { title, song: title, mood: title, duration: '3:20', x: 42 };
        expect(rowText(key, values)).toBe(i18n.t(key, values));
      }
    }
  }
});
