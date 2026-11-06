"""Pure building blocks of the pipeline run (run_pipeline.py).

Nothing in this package touches the network, the database or the data
directory: it shapes rows and reports so it can be tested in isolation.
run_pipeline.py re-exports every public name here, so existing imports
of the form ``from run_pipeline import share_band`` keep working.
"""
