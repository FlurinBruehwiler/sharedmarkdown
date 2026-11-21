namespace SharedMarkdown;

public sealed class DocState(string id)
{
    public string Id { get; } = id;
    public readonly SemaphoreSlim Lock = new(1, 1);

    // Guarded by Lock: Submit mutates Doc concurrently, so never touch these without it.
    public Rga Doc = new();
    public bool Dirty;
    public string CreatorIp = "";
    public string? ReadId;
    public int Viewers;
    public bool Persisted;
    public DateTime UpdatedAt = DateTime.UtcNow;

    // Set under Lock, read without it.
    public volatile bool Deleted;
    // Whoever got this state from DocStore.Get and sees Evicted once holding Lock must Get again, or its edits are lost.
    public volatile bool Evicted;
    // Updated at flush, so /api/titles never reads Doc without the lock.
    public volatile string Title = "";

    long _lastTouched = Environment.TickCount64;
    public long LastTouched => Interlocked.Read(ref _lastTouched);
    public void Touch() => Interlocked.Exchange(ref _lastTouched, Environment.TickCount64);

    public bool IsNew => !Persisted && Doc.Items == 0 && ReadId == null;
}
