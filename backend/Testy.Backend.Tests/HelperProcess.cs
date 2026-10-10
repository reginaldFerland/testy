using System.Diagnostics;
using System.Runtime.InteropServices;
using Xunit;

namespace Testy.Backend.Tests;

// Runs a bundled helper the way the extension does: `dotnet <helper>.dll`, from the test output.
internal static class HelperProcess
{
    // <root>/shared/Microsoft.NETCore.App/<version>/ belongs to the dotnet that runs these tests.
    private static readonly string Dotnet = Path.Combine(
        Path.GetFullPath(Path.Combine(RuntimeEnvironment.GetRuntimeDirectory(), "..", "..", "..")), OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet");

    public static string Output(string name) => Path.Combine(AppContext.BaseDirectory, name);

    // Starts `dotnet <assembly> <arguments>` with all three standard streams redirected.
    public static Process Start(string assembly, IEnumerable<string> arguments, IDictionary<string, string?>? environment = null)
    {
        var start = new ProcessStartInfo(Dotnet) { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        start.ArgumentList.Add(assembly);
        foreach (var argument in arguments) { start.ArgumentList.Add(argument); }
        foreach (var (name, value) in environment ?? new Dictionary<string, string?>()) { start.Environment[name] = value; }
        return Process.Start(start)!;
    }

    public static Task<(int ExitCode, string Output, string Error)> Run(string helper, IEnumerable<string> arguments, IDictionary<string, string?>? environment = null) =>
        Run(Start(Output(helper), arguments, environment));

    public static async Task<(int ExitCode, string Output, string Error)> Run(Process started)
    {
        using var process = started;
        // stdin stays open until exit: the process host treats its end as cancellation.
        var output = process.StandardOutput.ReadToEndAsync(TestContext.Current.CancellationToken);
        var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
        await process.WaitForExitAsync(TestContext.Current.CancellationToken).WaitAsync(TimeSpan.FromSeconds(60), TestContext.Current.CancellationToken);
        return (process.ExitCode, await output, await error);
    }
}
