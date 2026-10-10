# The first baseline

The first time a workspace opens, Testy asks before it builds anything: **Run Now** starts the baseline, **Not Now** waits for a save or a manual run (and asks again next time), and **Don't Ask Again** keeps this workspace waiting for a save or a manual run. Workspaces that already have a retained baseline continue automatically.

The baseline restores and builds the projects, discovers tests, and runs each test file separately to learn which source files it exercises. Progress appears in the status bar, for example `Testy: Testing 4/12`, and a baseline progress indicator shows the percentage of test files learned.

Later saves only build and run the test files affected by the change. When information is incomplete, Testy falls back to every test file in the affected project. **Testy: Show Output** explains each selection, and **Why Was This Selected?** in a Test Explorer item's context menu explains it for that item.
