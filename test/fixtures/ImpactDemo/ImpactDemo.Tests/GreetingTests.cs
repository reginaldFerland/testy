using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace ImpactDemo.Tests;

[TestClass]
public class GreetingTests
{
    [TestMethod]
    public void GreetsByName()
    {
        Assert.AreEqual("Hello, Ada", Greeting.For("Ada"));
        Assert.AreEqual(3, Arithmetic.Expected);
    }
}
