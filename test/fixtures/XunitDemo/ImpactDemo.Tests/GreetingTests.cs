using Xunit;

namespace ImpactDemo.Tests;

public class GreetingTests
{
    [Fact]
    [Trait("Category", "Fast")]
    public void GreetsByName()
    {
        Assert.Equal("Hello, Ada", Greeting.For("Ada"));
        Assert.Equal(3, Arithmetic.Expected);
    }
}
