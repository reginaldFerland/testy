# The first baseline

When a workspace opens, Testy restores and builds the projects, discovers tests, and runs each test file separately to learn which source files it exercises. Progress appears in the status bar, for example `Testy: Testing 4/12`, and a baseline progress indicator shows the percentage of test files learned.

Later saves only build and run the test files affected by the change. When information is incomplete, Testy falls back to every test file in the affected project. **Testy: Show Output** explains each selection.
