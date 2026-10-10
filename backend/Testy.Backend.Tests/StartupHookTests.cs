using System.Reflection;
using System.Text;
using Xunit;

namespace Testy.Backend.Tests;

// The runtime observer is a startup hook in the observed test host. Each process writes one
// log: "ready" with its entry assembly, a "module" line per listed assembly it loads, and
// "complete" when it exits normally (src/services/runtimeObservation.ts reads these).
[Collection(ProcessState.Name)]
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

    // The observed host must not pass the hook on to the applications it starts. The hook runs
    // in this process with the test assembly as the host, which makes it detach itself.
    [Fact]
    public void TheObservedHostDoesNotPassTheHookOnToItsChildren()
    {
        var observer = HelperProcess.Output("Testy.RuntimeObserver.dll");
        var other = Path.Combine(directory, "Other.dll");
        var manifest = Environment.GetEnvironmentVariable("TESTY_RUNTIME_OBSERVATION");
        var hooks = Environment.GetEnvironmentVariable("DOTNET_STARTUP_HOOKS");
        try
        {
            Environment.SetEnvironmentVariable("TESTY_RUNTIME_OBSERVATION", Manifest(Assembly.GetEntryAssembly()!.Location));
            Environment.SetEnvironmentVariable("DOTNET_STARTUP_HOOKS", string.Join(Path.PathSeparator, other, observer));
            var hook = Assembly.LoadFrom(observer).GetType("StartupHook", throwOnError: true)!;
            hook.GetMethod("Initialize")!.Invoke(null, null);
            Assert.Null(Environment.GetEnvironmentVariable("TESTY_RUNTIME_OBSERVATION"));
            Assert.Equal(other, Environment.GetEnvironmentVariable("DOTNET_STARTUP_HOOKS"));
        }
        finally
        {
            Environment.SetEnvironmentVariable("TESTY_RUNTIME_OBSERVATION", manifest);
            Environment.SetEnvironmentVariable("DOTNET_STARTUP_HOOKS", hooks);
        }
    }

    // A hook that cannot load is fatal on an older runtime, and intermediate managed processes
    // (a coverage collector) inherit it, so it targets the oldest runtime that can run them.
    [Fact]
    public void TheHookTargetsAnOlderRuntimeThanTheTests()
    {
        var target = Assembly.LoadFrom(HelperProcess.Output("Testy.RuntimeObserver.dll"))
            .GetCustomAttribute<System.Runtime.Versioning.TargetFrameworkAttribute>()!.FrameworkName;
        Assert.Equal(".NETCoreApp,Version=v8.0", target);
    }
}
