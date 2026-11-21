namespace SharedMarkdown;

/// Saves changed documents every 2 s and once more at shutdown.
///
/// The final flush runs in StoppedAsync, i.e. after every hosted service has stopped, including the web
/// server: hosted services stop in reverse registration order and the server was registered first, so a
/// flush in StopAsync would still be followed by Submits that are then lost.
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

    public async Task StoppedAsync(CancellationToken ct)
    {
        try
        {
            await store.Flush(evict: false);
            log.LogInformation("Saved documents at shutdown");
        }
        catch (ObjectDisposedException) { } // stopped again after disposal (WebApplicationFactory does that); already saved
    }

    public Task StartingAsync(CancellationToken ct) => Task.CompletedTask;
    public Task StartedAsync(CancellationToken ct) => Task.CompletedTask;
    public Task StoppingAsync(CancellationToken ct) => Task.CompletedTask;
}
