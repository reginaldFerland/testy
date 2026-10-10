using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

namespace Testy.Analysis;

// Long-lived source analysis over line-delimited JSON (one UTF-8 line each way).
//   in:  {"id":1,"cwd":"/work","request":{...one-shot request...}}   {"cancel":1}
//   out: {"ready":1,"roslyn":"version from directory"}   {"id":1,"result":<one-shot response>}   {"id":1,"error":"text"}
// Requests run concurrently and answer in completion order. A cancelled request
// answers with an error. Malformed requests, and requests reusing the id of one
// still running, are logged to stderr and not answered. The process exits when
// stdin closes, so it cannot outlive an extension host that died without cleaning up.
// Only source analysis is served: graph evaluation stays in per-request MSBuild
// processes because its cache validity depends on a fresh evaluation.
static class AnalyzerServer
{
    public static async Task<int> RunAsync(Stream input, Stream output)
    {
        var running = new ConcurrentDictionary<long, CancellationTokenSource>();
        var tasks = new ConcurrentDictionary<Task, byte>();
        var gate = new SemaphoreSlim(1, 1);
        async Task Write(string line)
        {
            await gate.WaitAsync();
            try
            {
                var bytes = Encoding.UTF8.GetBytes(line + "\n");
                await output.WriteAsync(bytes);
                await output.FlushAsync();
            }
            finally { gate.Release(); }
        }
        async Task Serve(long id, JsonDocument document, CancellationTokenSource cancellation)
        {
            string line;
            try
            {
                var envelope = document.RootElement;
                var request = envelope.GetProperty("request");
                var cwd = envelope.TryGetProperty("cwd", out var directory) ? directory.GetString()! : Directory.GetCurrentDirectory();
                // Provenance binds a response to the exact bytes the caller serialized.
                var result = await SourceAnalysis.HandleAsync(request, Encoding.UTF8.GetBytes(request.GetRawText()), cwd, cancellation.Token);
                line = $"{{\"id\":{id},\"result\":{result}}}";
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { line = $"{{\"id\":{id},\"error\":\"cancelled\"}}"; }
            catch (Exception exception) { line = $"{{\"id\":{id},\"error\":{JsonSerializer.Serialize(exception.ToString())}}}"; }
            finally { running.TryRemove(KeyValuePair.Create(id, cancellation)); cancellation.Dispose(); document.Dispose(); }
            try { await Write(line); }
            catch (IOException) { /* The host closed the pipe; the read loop sees EOF. */ }
        }
        await SourceAnalysis.WarmAsync();
        await Write($"{{\"ready\":1,\"roslyn\":{JsonSerializer.Serialize(SourceAnalysis.Describe())}}}");
        using var reader = new StreamReader(input, new UTF8Encoding(false));
        while (await reader.ReadLineAsync() is { } line)
        {
            if (line.Length == 0) { continue; }
            // Owned here until Serve takes it.
            JsonDocument? document = null;
            try
            {
                document = JsonDocument.Parse(line);
                var root = document.RootElement;
                if (root.TryGetProperty("cancel", out var cancel))
                {
                    if (running.TryGetValue(cancel.GetInt64(), out var target)) { try { target.Cancel(); } catch (ObjectDisposedException) { } }
                    continue;
                }
                var id = root.GetProperty("id").GetInt64();
                var cancellation = new CancellationTokenSource();
                // An answer carrying a duplicate id would settle the caller's earlier request, so none is sent.
                if (!running.TryAdd(id, cancellation))
                {
                    cancellation.Dispose();
                    Console.Error.WriteLine($"Ignored a request with the duplicate id {id}.");
                    continue;
                }
                var owned = document;
                document = null;
                var task = Task.Run(() => Serve(id, owned, cancellation));
                tasks[task] = 0;
                _ = task.ContinueWith(finished => tasks.TryRemove(finished, out _), TaskScheduler.Default);
            }
            catch (Exception exception) when (exception is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
            {
                Console.Error.WriteLine($"Ignored a malformed request: {exception.Message}");
            }
            finally { document?.Dispose(); }
        }
        foreach (var source in running.Values) { try { source.Cancel(); } catch (ObjectDisposedException) { } }
        await Task.WhenAll(tasks.Keys);
        return 0;
    }
}
