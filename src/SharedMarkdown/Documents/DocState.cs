namespace SharedMarkdown;

/// A document loaded in memory (see DocStore).
///
/// Locking: fields marked [Lock] may only be read or written while holding <see cref="Lock"/>. The others say
/// who writes them; they are read without the lock.
public sealed class DocState(string id)
{
    public string Id { get; } = id;
    public readonly SemaphoreSlim Lock = new(1, 1);

    /// [Lock] The replica. Never touch it without the lock: Submit mutates it concurrently.
    public Rga Doc = new();
    /// [Lock] Changed since the last flush.
    public bool Dirty;
    /// [Lock] IP that created the document (counted against its "new documents" limit).
    public string CreatorIp = "";
    /// [Lock] Id of the read-only link (/r/{ReadId}), null until someone asks for one. Never sent to editors' peers.
    public string? ReadId;
    /// [Lock] Connections that joined this document.
    public int Viewers;
    /// [Lock] Has a database row. Set by DocStore.Flush.
    public bool Persisted;
    /// [Lock] Last-modified time of the stored row when loaded; decides whether it may be compacted.
    public DateTime UpdatedAt = DateTime.UtcNow;

    /// Set (under the lock) when an admin deletes the document. Joiners and submitters that see it stop.
    public volatile bool Deleted;
    /// Set (under the lock) when DocStore drops the document from memory. Someone who got this state from
    /// DocStore.Get but sees Evicted once holding the lock must call Get again, or their edits would be lost.
    public volatile bool Evicted;
    /// Title as of the last flush (or load); read without the lock by /api/titles.
    public volatile string Title = "";

    long _lastTouched = Environment.TickCount64;
    /// Last time someone fetched or left the document (Environment.TickCount64), for eviction.
    public long LastTouched => Interlocked.Read(ref _lastTouched);
    public void Touch() => Interlocked.Exchange(ref _lastTouched, Environment.TickCount64);

    /// [Lock] True until the first edit (or read link); that counts as creating the document.
    public bool IsNew => !Persisted && Doc.Items == 0 && ReadId == null;
}
