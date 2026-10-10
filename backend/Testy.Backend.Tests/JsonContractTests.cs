using System.IO.Pipelines;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Testy.Analysis;
using Xunit;

namespace Testy.Backend.Tests;

// The TypeScript side reads these responses by name (src/services/analyzer*.ts), so the
// property names and shapes are a contract: camelCase, and exactly these members.
public sealed class JsonContractTests : IDisposable
{
    private readonly string directory = Directory.CreateTempSubdirectory("testy-json-").FullName;

    public void Dispose() => Directory.Delete(directory, recursive: true);

    private string Source(string name, string text)
    {
        File.WriteAllText(Path.Combine(directory, name), text);
        return name;
    }

    private async Task<(JsonDocument Response, byte[] Request)> Handle(string request)
    {
        var bytes = Encoding.UTF8.GetBytes(request);
        using var document = JsonDocument.Parse(bytes);
        var response = await SourceAnalysis.HandleAsync(document.RootElement, bytes, directory, CancellationToken.None);
        return (JsonDocument.Parse(response), bytes);
    }

    private static string[] Names(JsonElement element) => [.. element.EnumerateObject().Select(property => property.Name)];

    [Fact]
    public async Task AnalysesAreKeyedByRequestedPathWithCamelCaseShapes()
    {
        var file = Source("a.cs", "namespace N; [System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage] public partial class C { int M() => 1; }");
        Source("broken.cs", "class {");
        var (response, _) = await Handle($$"""{"files":["{{file}}","missing.cs","broken.cs"],"excludedAliases":[]}""");
        using (response)
        {
            Assert.Equal(["a.cs", "missing.cs", "broken.cs"], Names(response.RootElement));
            var shape = response.RootElement.GetProperty("a.cs");
            Assert.Equal(["signature", "body", "partialTypes", "excludedTypes"], Names(shape));
            Assert.Equal(JsonValueKind.String, shape.GetProperty("signature").ValueKind);
            Assert.Equal(["N:C`0"], shape.GetProperty("partialTypes").EnumerateArray().Select(item => item.GetString()));
            Assert.Equal(["N:C`0"], shape.GetProperty("excludedTypes").EnumerateArray().Select(item => item.GetString()));
            // An unreadable file is unknown, not a failure of the batch.
            Assert.Equal(JsonValueKind.Null, response.RootElement.GetProperty("missing.cs").ValueKind);
        }
    }

    [Fact]
    public async Task ASyntaxErrorIsUnknown()
    {
        Source("broken.cs", "class {");
        var (response, _) = await Handle("""{"files":["broken.cs"],"excludedAliases":[]}""");
        using (response) { Assert.Equal(JsonValueKind.Null, response.RootElement.GetProperty("broken.cs").ValueKind); }
    }

    [Fact]
    public async Task ProvenanceBindsTheResponseToTheRequestBytes()
    {
        Source("a.cs", "class C { }");
        var (response, request) = await Handle("""{"files":["a.cs","missing.cs"],"excludedAliases":[],"provenance":true}""");
        using (response)
        {
            Assert.Equal(["version", "requestHash", "aliases", "analyses", "sourceHashes"], Names(response.RootElement));
            Assert.Equal(1, response.RootElement.GetProperty("version").GetInt32());
            Assert.Equal(Convert.ToHexString(SHA256.HashData(request)), response.RootElement.GetProperty("requestHash").GetString());
            Assert.Equal(JsonValueKind.Array, response.RootElement.GetProperty("aliases").ValueKind);
            Assert.Equal(["a.cs", "missing.cs"], Names(response.RootElement.GetProperty("analyses")));
            var hashes = response.RootElement.GetProperty("sourceHashes");
            Assert.Equal(["a.cs", "missing.cs"], Names(hashes));
            Assert.Matches("^[0-9A-F]{64}$", hashes.GetProperty("a.cs").GetString());
            Assert.Equal(JsonValueKind.Null, hashes.GetProperty("missing.cs").ValueKind);
        }
    }

    [Fact]
    public async Task ACombinedRequestAnswersWithAliasesAndAnalyses()
    {
        Source("a.cs", "[Hidden] class C { int M() => 1; }");
        const string alias = "global using Hidden = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;";
        var (response, _) = await Handle($$"""{"files":["a.cs"],"allFiles":["a.cs"],"aliasSources":["{{alias}}"],"excludedAliases":[]}""");
        using (response)
        {
            Assert.Equal(["aliases", "analyses"], Names(response.RootElement));
            Assert.Equal(["Hidden"], response.RootElement.GetProperty("aliases").EnumerateArray().Select(item => item.GetString()));
            var shape = response.RootElement.GetProperty("analyses").GetProperty("a.cs");
            Assert.Equal(["signature", "body", "partialTypes", "excludedTypes"], Names(shape));
            Assert.Equal(shape.GetProperty("signature").GetString(), shape.GetProperty("body").GetString());
        }
    }

    [Fact]
    public async Task AliasSourcesAloneAnswerWithAnArrayOfNames()
    {
        var (response, _) = await Handle("""{"aliasSources":["global using B = System.Diagnostics.DebuggerHiddenAttribute;","global using A = System.Diagnostics.DebuggerHiddenAttribute;","class C { }"]}""");
        using (response) { Assert.Equal(["A", "B"], response.RootElement.EnumerateArray().Select(item => item.GetString())); }
    }

    [Fact]
    public async Task AssemblyLocationsReportFileAndLine()
    {
        var request = JsonSerializer.Serialize(new { assembly = typeof(JsonContractTests).Assembly.Location });
        var (response, _) = await Handle(request);
        using (response)
        {
            var key = $"{typeof(JsonContractTests).FullName}.{nameof(AssemblyLocationsReportFileAndLine)}";
            var location = response.RootElement.GetProperty(key);
            Assert.Equal(["file", "line"], Names(location));
            Assert.EndsWith(nameof(JsonContractTests) + ".cs", location.GetProperty("file").GetString(), StringComparison.Ordinal);
            Assert.True(location.GetProperty("line").GetInt32() > 0);
        }
    }

    [Fact]
    public async Task AMalformedRequestThrows()
    {
        await Assert.ThrowsAsync<KeyNotFoundException>(() => Handle("{}"));
        await Assert.ThrowsAsync<ArgumentException>(() => Handle("""{"files":null,"excludedAliases":[]}"""));
    }

    // The server answers in completion order and cancels what is still running when stdin
    // closes, so the input stays open until every answer has arrived.
    [Fact]
    public async Task TheServerSpeaksLineDelimitedJsonWithLowerCaseEnvelopes()
    {
        Source("a.cs", "class C { }");
        var cwd = JsonSerializer.Serialize(directory);
        var requests = new Pipe();
        var responses = new Pipe();
        var server = AnalyzerServer.RunAsync(requests.Reader.AsStream(), responses.Writer.AsStream());
        using var reader = new StreamReader(responses.Reader.AsStream(), Encoding.UTF8);
        async Task<JsonDocument> Next() => JsonDocument.Parse(await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(60)) ?? throw new EndOfStreamException());
        var ready = await Next();
        await requests.Writer.AsStream().WriteAsync(Encoding.UTF8.GetBytes($$$"""
            {"id":1,"cwd":{{{cwd}}},"request":{"files":["a.cs"],"excludedAliases":[]}}
            {"id":2,"request":{}}
            {"id":3,"cwd":{{{cwd}}},"request":{"aliasSources":[]}}

            """), TestContext.Current.CancellationToken);
        var answers = new[] { await Next(), await Next(), await Next() };
        await requests.Writer.CompleteAsync();
        Assert.Equal(0, await server.WaitAsync(TimeSpan.FromSeconds(60), TestContext.Current.CancellationToken));
        using (ready)
        {
            Assert.Equal(["ready", "roslyn"], Names(ready.RootElement));
            Assert.Equal(1, ready.RootElement.GetProperty("ready").GetInt32());
            Assert.Equal(JsonValueKind.String, ready.RootElement.GetProperty("roslyn").ValueKind);
        }
        try
        {
            var byId = answers.ToDictionary(line => line.RootElement.GetProperty("id").GetInt64());
            Assert.Equal([1L, 2L, 3L], byId.Keys.Order());
            Assert.Equal(["id", "result"], Names(byId[1].RootElement));
            Assert.Equal(["signature", "body", "partialTypes", "excludedTypes"], Names(byId[1].RootElement.GetProperty("result").GetProperty("a.cs")));
            Assert.Equal(["id", "error"], Names(byId[2].RootElement));
            Assert.Equal(typeof(KeyNotFoundException).FullName, byId[2].RootElement.GetProperty("error").GetProperty("type").GetString());
            Assert.Equal(JsonValueKind.Array, byId[3].RootElement.GetProperty("result").ValueKind);
        }
        finally { foreach (var answer in answers) { answer.Dispose(); } }
    }
}
