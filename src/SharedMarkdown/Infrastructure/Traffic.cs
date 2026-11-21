using Microsoft.AspNetCore.SignalR;

namespace SharedMarkdown;

public sealed class Traffic
{
    long _requests, _hubIn, _hubOut;

    public void Request() => Interlocked.Increment(ref _requests);
    public void HubIn() => Interlocked.Increment(ref _hubIn);
    public void HubOut(int recipients) { if (recipients > 0) Interlocked.Add(ref _hubOut, recipients); }

    public (long Requests, long HubIn, long HubOut) Totals =>
        (Interlocked.Read(ref _requests), Interlocked.Read(ref _hubIn), Interlocked.Read(ref _hubOut));
}

public sealed class TrafficHubFilter(Traffic traffic) : IHubFilter
{
    public ValueTask<object?> InvokeMethodAsync(HubInvocationContext context, Func<HubInvocationContext, ValueTask<object?>> next)
    {
        traffic.HubIn();
        return next(context);
    }
}
