using NUnit.Framework;

namespace ImpactDemo.Tests;

public class GreetingTests
{
    [Test]
    [Category("Fast")]
    public void GreetsByName()
    {
        Assert.That(Greeting.For("Ada"), Is.EqualTo("Hello, Ada"));
        Assert.That(Arithmetic.Expected, Is.EqualTo(3));
    }
}
