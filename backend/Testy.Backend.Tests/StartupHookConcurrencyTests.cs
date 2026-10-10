using System.Reflection;
using System.Reflection.Emit;
using System.Text;
using Xunit;

namespace Testy.Backend.Tests;

// The hook runs on whichever thread loads an assembly, so loads from several threads arrive
// while another thread is writing a line. Each listed assembly must still be recorded exactly
// once, as a whole line, and unlisted loads must not reach the log.
[Collection(ProcessState.Name)]
public sealed class StartupHookConcurrencyTests : IDisposable
{
    private readonly string directory = Directory.CreateTempSubdirectory("testy-observer-concurrent-").FullName;

    public void Dispose()
    {
        // The hook keeps its log open for the life of this process, which Windows will not delete.
        try { Directory.Delete(directory, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static string Encode(string value) => Convert.ToBase64String(Encoding.UTF8.GetBytes(value));

    [Fact]
    public async Task LoadsFromSeveralThreadsAreEachRecordedOnce()
    {
        const int Threads = 8;
        const int PerThread = 100;
        var listed = Enumerable.Range(0, Threads * PerThread).Select(index => $"TestyObserved{index}").ToArray();
        var manifest = Path.Combine(directory, "manifest.txt");
        // The test assembly as host makes the hook detach, which keeps it from leaking into later tests.
        File.WriteAllLines(manifest, new[] { directory, Assembly.GetEntryAssembly()!.Location }.Concat(listed).Select(Encode));
        var previousManifest = Environment.GetEnvironmentVariable("TESTY_RUNTIME_OBSERVATION");
        var previousHooks = Environment.GetEnvironmentVariable("DOTNET_STARTUP_HOOKS");
        try
        {
            Environment.SetEnvironmentVariable("TESTY_RUNTIME_OBSERVATION", manifest);
            Assembly.LoadFrom(HelperProcess.Output("Testy.RuntimeObserver.dll")).GetType("StartupHook", throwOnError: true)!
                .GetMethod("Initialize")!.Invoke(null, null);
        }
        finally
        {
            Environment.SetEnvironmentVariable("TESTY_RUNTIME_OBSERVATION", previousManifest);
            Environment.SetEnvironmentVariable("DOTNET_STARTUP_HOOKS", previousHooks);
        }
        using var start = new Barrier(Threads);
        await Task.WhenAll(Enumerable.Range(0, Threads).Select(thread => Task.Factory.StartNew(() =>
        {
            start.SignalAndWait();
            for (var index = 0; index < PerThread; index++)
            {
                // Listed and unlisted loads interleave, and every thread loads the same unlisted names.
                AssemblyBuilder.DefineDynamicAssembly(new AssemblyName(listed[thread * PerThread + index]), AssemblyBuilderAccess.Run);
                AssemblyBuilder.DefineDynamicAssembly(new AssemblyName($"TestyUnlisted{index}"), AssemblyBuilderAccess.Run);
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default)));

        using var stream = new FileStream(Assert.Single(Directory.GetFiles(directory, "*.log")), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(stream);
        var lines = (await reader.ReadToEndAsync(TestContext.Current.CancellationToken)).Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.StartsWith("ready\t", lines[0], StringComparison.Ordinal);
        var modules = lines.Skip(1).Select(line => line.Split('\t')).ToArray();
        // No torn or interleaved lines: each is "module", an encoded name and an (empty, dynamic) location.
        Assert.All(modules, fields => Assert.Equal(3, fields.Length));
        Assert.All(modules, fields => Assert.Equal("module", fields[0]));
        Assert.Equal(listed.Order(StringComparer.Ordinal), modules.Select(fields => Encoding.UTF8.GetString(Convert.FromBase64String(fields[1]))).Order(StringComparer.Ordinal));
    }
}
