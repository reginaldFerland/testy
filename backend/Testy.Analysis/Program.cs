using System.Reflection;
using System.Text;
using System.Text.Json;

namespace Testy.Analysis;

// Usage: Testy.Analysis <request.json> <response.json>
//        Testy.Analysis --server
// One-shot mode writes the result to the response file because stdout is
// bounded by the caller; stdout and stderr carry diagnostics only. Server mode
// keeps the process (and its JIT-compiled Roslyn) alive for line-delimited
// requests, see AnalyzerServer.
static class Program
{
    // The installed Roslyn failed to load or its self-test failed. The extension must not fall
    // back to another run on the same Roslyn (src/services/analyzerServer.ts).
    internal const int SelfTestFailedExitCode = 70;

    // The extension version this helper was built for (see Directory.Build.props), reported when the server starts.
    internal static string Version { get; } = typeof(Program).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "";

    // Verifies the Roslyn this process runs on before any request is trusted.
    internal static async Task VerifyRoslynAsync()
    {
        try { await SourceAnalysis.WarmAsync(); }
        catch (Exception exception) { throw new SelfTestFailedException(exception); }
    }

    static async Task<int> Main(string[] args)
    {
        // Console streams default to the OEM/ANSI code page on Windows, but the
        // extension decodes diagnostics as UTF-8.
        var utf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        // Nothing may touch Roslyn before this, including the JIT compiling a caller.
        RoslynLoader.Register();
        Console.SetError(new StreamWriter(Console.OpenStandardError(), utf8) { AutoFlush = true });
        try
        {
            if (args is ["--server"])
            {
                var output = Console.OpenStandardOutput();
                // The protocol owns stdout; nothing else may write to it.
                Console.SetOut(Console.Error);
                return await AnalyzerServer.RunAsync(Console.OpenStandardInput(), output);
            }
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true });
            if (args.Length != 2) { throw new ArgumentException("Expected a request file and a response file."); }
            var requestBytes = await File.ReadAllBytesAsync(args[0]);
            using var requestStream = new MemoryStream(requestBytes, writable: false);
            using var requestReader = new StreamReader(requestStream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            using var request = JsonDocument.Parse(await requestReader.ReadToEndAsync());
            // Reading portable symbols needs no Roslyn; every other request is fingerprinted with it.
            if (!request.RootElement.TryGetProperty("assembly", out _)) { await VerifyRoslynAsync(); }
            var response = await SourceAnalysis.HandleAsync(request.RootElement, requestBytes, Directory.GetCurrentDirectory(), CancellationToken.None);
            await File.WriteAllTextAsync(args[1], response, utf8);
            return 0;
        }
        catch (Exception exception)
        {
            if (RoslynLoader.Failure is { } failure) { Console.Error.WriteLine(failure); }
            Console.Error.WriteLine(exception.ToString());
            return exception is SelfTestFailedException ? SelfTestFailedExitCode : 1;
        }
    }
}

sealed class SelfTestFailedException(Exception inner) : Exception("The Roslyn self-test failed: " + inner.Message, inner);
