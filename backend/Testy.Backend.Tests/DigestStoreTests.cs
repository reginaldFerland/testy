using Testy.Analysis;
using Xunit;

namespace Testy.Backend.Tests;

// SDK file digests persist between evaluation processes. A stored digest is trusted only for
// the exact (path, length, write time) it was taken at, and a damaged store is just a miss.
public sealed class DigestStoreTests : IDisposable
{
    private readonly string directory = Directory.CreateTempSubdirectory("testy-digests-").FullName;
    private static readonly string Hash = new('a', 64);

    public void Dispose() => Directory.Delete(directory, recursive: true);

    private string Store() => Directory.GetFiles(directory, "digests-*.json").Single();

    [Fact]
    public void DigestsSurviveAProcessAndOnlyMatchTheirStamp()
    {
        var first = DigestStore.Open(directory, "/sdk");
        Assert.Null(first.TryGet("/sdk/a.dll", 10, 20));
        first.Add("/sdk/a.dll", 10, 20, Hash);
        first.Save();
        var second = DigestStore.Open(directory, "/sdk");
        Assert.Equal(Hash, second.TryGet("/sdk/a.dll", 10, 20));
        Assert.Null(second.TryGet("/sdk/a.dll", 11, 20));
        Assert.Null(second.TryGet("/sdk/a.dll", 10, 21));
        Assert.Null(DigestStore.Open(directory, "/other-sdk").TryGet("/sdk/a.dll", 10, 20));
        Assert.Empty(Directory.GetFiles(directory, "*.tmp"));
    }

    [Fact]
    public void OnlyFilesOfTheLatestEvaluationAreKept()
    {
        var first = DigestStore.Open(directory, "/sdk");
        first.Add("/sdk/a.dll", 1, 1, Hash);
        first.Add("/sdk/b.dll", 2, 2, Hash);
        first.Save();
        var second = DigestStore.Open(directory, "/sdk");
        Assert.NotNull(second.TryGet("/sdk/a.dll", 1, 1));
        second.Save();
        var third = DigestStore.Open(directory, "/sdk");
        Assert.NotNull(third.TryGet("/sdk/a.dll", 1, 1));
        Assert.Null(third.TryGet("/sdk/b.dll", 2, 2));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("{\"version\":2,\"entries\":{}}")]
    [InlineData("{\"version\":1,\"entries\":null}")]
    [InlineData("{\"version\":1,\"entries\":{\"/sdk/a.dll\":{\"length\":1,\"ticks\":1,\"hash\":\"nothex\"}}}")]
    [InlineData("{\"version\":1,\"entries\":{\"/sdk/a.dll\":null}}")]
    public void ADamagedStoreIsIgnoredAndReplaced(string contents)
    {
        var seed = DigestStore.Open(directory, "/sdk");
        seed.Add("/sdk/x.dll", 1, 1, Hash);
        seed.Save();
        File.WriteAllText(Store(), contents);
        var store = DigestStore.Open(directory, "/sdk");
        Assert.Null(store.TryGet("/sdk/a.dll", 1, 1));
        store.Add("/sdk/a.dll", 1, 1, Hash);
        store.Save();
        Assert.Equal(Hash, DigestStore.Open(directory, "/sdk").TryGet("/sdk/a.dll", 1, 1));
    }

    [Fact]
    public void AnUnwritableDirectoryOnlyCostsTheCache()
    {
        var blocked = Path.Combine(directory, "file");
        File.WriteAllText(blocked, "");
        var store = DigestStore.Open(Path.Combine(blocked, "inside"), "/sdk");
        store.Add("/sdk/a.dll", 1, 1, Hash);
        store.Save();
        Assert.Null(DigestStore.Open(Path.Combine(blocked, "inside"), "/sdk").TryGet("/sdk/a.dll", 1, 1));
    }

    [Fact]
    public async Task ConcurrentProcessesLeaveAWholeStore()
    {
        await Task.WhenAll(Enumerable.Range(0, 8).Select(index => Task.Run(() =>
        {
            for (var round = 0; round < 20; round++)
            {
                var store = DigestStore.Open(directory, "/sdk");
                store.Add($"/sdk/{index}-{round}.dll", index, round, Hash);
                store.Save();
            }
        })));
        // Whichever rename came last, the store is complete and readable, and nothing is left behind.
        var survivor = DigestStore.Open(directory, "/sdk");
        Assert.Single(Directory.GetFiles(directory));
        Assert.Contains(Enumerable.Range(0, 8), index => survivor.TryGet($"/sdk/{index}-19.dll", index, 19) is not null);
    }
}
