import os
import sys

# Ensure backend module can be imported cleanly during test runs
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
