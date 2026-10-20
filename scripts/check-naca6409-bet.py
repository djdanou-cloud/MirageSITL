"""Compatibility CLI; delegates to the configuration-driven TASK-033 suite."""
import runpy
from pathlib import Path

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).with_name("check-rotor-bet.py")), run_name="__main__")
