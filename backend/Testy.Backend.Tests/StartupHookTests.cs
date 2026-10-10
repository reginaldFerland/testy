using System.Text;
using Xunit;

namespace Testy.Backend.Tests;

// The runtime observer is a startup hook in the observed test host. Each process writes one
// log: "ready" with its entry assembly, a "module" line per listed assembly it loads, and
// "complete" when it exits normally (src/services/runtimeObservation.ts reads these).
public sealed class StartupHookTests : IDisposable
{
    private readonly string directory = Directory.CreateTempSubdirectory("testy-observer-").FullName;

    public void Dispose() => Directory.Delete(directory, recursive: true);

    private static string Encode(string value) => Convert.ToBase64String(Encoding.UTF8.GetBytes(value));

    private static string Decode(string value) => Encoding.UTF8.GetString(Convert.FromBase64String(value));

    // Any small .NET application will do as the observed process; the process host exits at once without arguments.
    private static Task<(int ExitCode, string Output, string Error)> Observe(string? manifest) => HelperProcess.Run("Testy.ProcessHost.dll", [],
        new Dictionary<string, string?> { ["DOTNET_STARTUP_HOOKS"] = HelperProcess.Output("Testy.RuntimeObserver.dll"), ["TESTY_RUNTIME_OBSERVATION"] = manifest });

    private string Manifest(string host, params string[] names)
    {
        var path = Path.Combine(directory, "manifest.txt");
        File.WriteAllLines(path, new[] { directory, host }.Concat(names).Select(Encode));
        return path;
    }

    private string[][] Log() => File.ReadAllLines(Assert.Single(Directory.GetFiles(directory, "*.log")))
        .Select(line => line.Split('\t')).Select(fields => fields[0] == "complete" ? fields : [fields[0], .. fields.Skip(1).Select(Decode)]).ToArray();

    [Fact]
    public async Task RecordsListedAssembliesAndCompletion()
    {
        var entry = HelperProcess.Output("Testy.ProcessHost.dll");
        var (exitCode, _, _) = await Observe(Manifest(entry, "Testy.ProcessHost", "System.Runtime"));
        Assert.Equal(125, exitCode);
        var log = Log();
        Assert.Equal(["ready", entry], log[0]);
        Assert.Contains(log, line => line.SequenceEqual(["module", "Testy.ProcessHost", entry]));
        Assert.Contains(log, line => line is ["module", "System.Runtime", _]);
        Assert.DoesNotContain(log, line => line is ["module", "System.Private.CoreLib", _]);
        Assert.Equal(["complete", "true"], log[^1]);
    }

    [Fact]
    public async Task WithoutAManifestNothingIsObserved()
    {
        var (exitCode, _, error) = await Observe(null);
        Assert.Equal(125, exitCode);
        Assert.StartsWith("Testy could not own the process tree:", error, StringComparison.Ordinal);
        Assert.Empty(Directory.GetFiles(directory));
    }

    [Fact]
    public async Task AnUnreadableManifestNeverStopsTheApplication()
    {
        var (exitCode, _, error) = await Observe(Path.Combine(directory, "missing.txt"));
        Assert.Equal(125, exitCode);
        Assert.StartsWith("Testy could not own the process tree:", error, StringComparison.Ordinal);
        Assert.Empty(Directory.GetFiles(directory));
    }
}
