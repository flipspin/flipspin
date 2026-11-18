"""One-off exporter; run in a disposable Python 3.11 environment.

Install tensorflow==2.15.1 and tf2onnx==1.16.1 there, never in the helper.
The input graph and generated model are release artifacts, not source files.
"""
import argparse
import hashlib
from pathlib import Path


def main():
    import tensorflow as tf
    import tf2onnx

    parser = argparse.ArgumentParser()
    parser.add_argument("graph", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    graph = tf.compat.v1.GraphDef()
    graph.ParseFromString(args.graph.read_bytes())
    tf2onnx.convert.from_graph_def(
        graph, input_names=["input:0"], output_names=["output:0"],
        opset=13, output_path=str(args.output),
    )
    print(hashlib.sha256(args.output.read_bytes()).hexdigest())


if __name__ == "__main__":
    main()
