#!/usr/bin/env python3
"""Entry point for the PyInstaller-packaged backend (scripts/build-backend.cjs)."""
import os
import sys

# Ensure app is on path when frozen
if getattr(sys, "frozen", False):
    app_dir = os.path.dirname(sys.executable)
    sys.path.insert(0, app_dir)

if __name__ == "__main__":
    from app.__main__ import main
    main()
