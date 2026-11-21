using System.Net;

namespace SharedMarkdown.Tests;

public class IpGuardTests
{
    [Fact]
    public void TryTakeCountsPerWindow()
    {
        long now = 1_000_000;
        var guard = new IpGuard(null!) { Clock = () => now };
        var minute = TimeSpan.FromMinutes(1);
        for (int i = 0; i < 3; i++) Assert.True(guard.TryTake("join", "1.2.3.4", 3, minute));
        Assert.False(guard.TryTake("join", "1.2.3.4", 3, minute));
        Assert.True(guard.TryTake("submit", "1.2.3.4", 3, minute));
        Assert.True(guard.TryTake("join", "5.6.7.8", 3, minute));
        Assert.Equal(3, guard.Used("join", "1.2.3.4"));

        now += 59_999;
        Assert.False(guard.TryTake("join", "1.2.3.4", 3, minute));
        now += 1;
        Assert.True(guard.TryTake("join", "1.2.3.4", 3, minute));
        Assert.Equal(1, guard.Used("join", "1.2.3.4"));
    }

    [Fact]
    public void ConnectionsAreLimited()
    {
        var guard = new IpGuard(null!);
        Assert.True(guard.TryConnect("a", 2));
        Assert.True(guard.TryConnect("a", 2));
        Assert.False(guard.TryConnect("a", 2));
        guard.Disconnect("a");
        Assert.True(guard.TryConnect("a", 2));
        Assert.Equal(2, guard.Connections);
    }

    [Theory]
    [InlineData("203.0.113.7", "203.0.113.7")]
    [InlineData("::ffff:203.0.113.7", "203.0.113.7")]
    [InlineData("127.0.0.1", "127.0.0.1")]
    [InlineData("::1", "::1")]
    [InlineData("2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64")]
    [InlineData("2001:db8:1:2:ffff:ffff:ffff:ffff", "2001:db8:1:2::/64")]
    [InlineData("2001:db8:1:3::1", "2001:db8:1:3::/64")]
    public void IpOfGroupsIpv6By64(string ip, string expected) => Assert.Equal(expected, IpGuard.IpOf(IPAddress.Parse(ip)));

    [Fact]
    public void IpOfWithoutAddress() => Assert.Equal("unknown", IpGuard.IpOf((IPAddress?)null));
}
