// SPDX-License-Identifier: AGPL-3.0-or-later
// Matches libKeyFinder 941e517's keyOfAudio/classifier; exposes the same scores.
#define PY_SSIZE_T_CLEAN
#include <Python.h>
#include "keyfinder.h"
#include "toneprofiles.h"
#include <cstring>
#include <limits>

static PyObject* analyse(PyObject*, PyObject* args) {
    PyObject* samples;
    unsigned rate;
    if (!PyArg_ParseTuple(args, "OI", &samples, &rate)) return nullptr;
    Py_buffer buffer;
    if (PyObject_GetBuffer(samples, &buffer, PyBUF_CONTIG_RO | PyBUF_FORMAT) < 0) return nullptr;
    if (buffer.ndim != 1 || buffer.itemsize != sizeof(float) ||
        !buffer.format || std::strcmp(buffer.format, "f") || buffer.len == 0 ||
        buffer.len / sizeof(float) > std::numeric_limits<unsigned>::max() || rate < 8000) {
        PyBuffer_Release(&buffer);
        PyErr_SetString(PyExc_ValueError, "Expected nonempty contiguous mono float32 samples and rate >= 8000");
        return nullptr;
    }
    try {
        KeyFinder::KeyFinder engine;
        KeyFinder::AudioData audio;
        audio.setFrameRate(rate);
        audio.setChannels(1);
        unsigned count = static_cast<unsigned>(buffer.len / sizeof(float));
        audio.addToSampleCount(count);
        const float* data = static_cast<const float*>(buffer.buf);
        for (unsigned i = 0; i < count; ++i) audio.setSample(i, data[i]);
        KeyFinder::Workspace workspace;
        engine.progressiveChromagram(audio, workspace);
        engine.finalChromagram(workspace);
        const auto chroma = workspace.chromagram->collapseToOneHop();
        KeyFinder::ToneProfile major(KeyFinder::toneProfileMajor());
        KeyFinder::ToneProfile minor(KeyFinder::toneProfileMinor());
        PyObject* scores = PyList_New(24);
        for (int i = 0; i < 12; ++i) {
            PyList_SET_ITEM(scores, i * 2, PyFloat_FromDouble(major.cosineSimilarity(chroma, i)));
            PyList_SET_ITEM(scores, i * 2 + 1, PyFloat_FromDouble(minor.cosineSimilarity(chroma, i)));
        }
        int label = static_cast<int>(engine.keyOfChromagram(workspace));
        PyBuffer_Release(&buffer);
        return Py_BuildValue("iN", label, scores);
    } catch (const std::exception& error) {
        PyBuffer_Release(&buffer);
        PyErr_SetString(PyExc_RuntimeError, error.what());
        return nullptr;
    }
}

static PyMethodDef methods[] = {{"analyse", analyse, METH_VARARGS, "Return (label, 24 cosine scores)."}, {nullptr, nullptr, 0, nullptr}};
static PyModuleDef module = {PyModuleDef_HEAD_INIT, "_native", nullptr, -1, methods};
PyMODINIT_FUNC PyInit__native() { return PyModule_Create(&module); }
