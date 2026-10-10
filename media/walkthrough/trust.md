# Workspace trust

Testy builds your projects and runs their tests, which executes code from the workspace. In Restricted Mode it builds and runs nothing: the status bar shows **Testy: Restricted Mode**, and Testy starts as soon as you trust the folder from the **Restricted Mode** banner or with **Workspaces: Manage Workspace Trust**. Settings that choose what Testy executes (such as `testy.dotnetPath`, `testy.testArguments` and `testy.solution`) are ignored from untrusted workspace settings.
