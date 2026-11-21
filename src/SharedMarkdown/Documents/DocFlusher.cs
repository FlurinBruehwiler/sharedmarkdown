namespace SharedMarkdown;

public class DocFlusher(DocStore store, IpGuard guard, ILogger<DocFlusher> log) : BackgroundService, IHostedLifecycleService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        var ticks = 0;
        try
        {
            while (await timer.WaitForNextTickAsync(ct))
            {
                try { await store.Flush(evict: true); }
                catch (Exception e) { log.LogError(e, "Flush failed"); }
                if (++ticks % 300 == 0) guard.Prune();
            }
        }
        catch (OperationCanceledException) { }
    }

    // Not StopAsync: the web server stops after the other hosted services, so Submits could still arrive after that flush.
    public async Task StoppedAsync(CancellationToken ct)
    {
        try
        {
            await store.Flush(evict: false);
            log.LogInformation("Saved documents at shutdown");
        }
        catch (ObjectDisposedException) { } // WebApplicationFactory stops the host again after disposing it
    }

    public Task StartingAsync(CancellationToken ct) => Task.CompletedTask;
    public Task StartedAsync(CancellationToken ct) => Task.CompletedTask;
    public Task StoppingAsync(CancellationToken ct) => Task.CompletedTask;
}
