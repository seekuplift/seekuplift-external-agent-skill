export default function Home() {
  return (
    <main style={{ maxWidth: 860, margin: '0 auto', padding: '3rem 1.5rem 6rem' }}>
      {/* Header */}
      <div style={{ marginBottom: '3rem' }}>
        <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3rem)', lineHeight: 1.1, marginBottom: '1rem' }}>
          SeekUplift Launchpad — Agent API
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: '1.125rem', maxWidth: 600 }}>
          A skill for your AI agent: browse launch options, launch coins, and trade on SeekUplift Launchpad.
          The API returns transactions; your agent signs and submits them.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem', flexWrap: 'wrap' }}>
          <a href="/skill.md" style={{ background: 'var(--accent)', color: '#fff', padding: '0.5rem 1rem', borderRadius: 'var(--radius)', fontSize: '0.875rem', fontWeight: 600 }}>
            SKILL.md
          </a>
          <a href="/skill.json" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', padding: '0.5rem 1rem', borderRadius: 'var(--radius)', fontSize: '0.875rem', fontWeight: 600 }}>
            skill.json
          </a>
        </div>
      </div>

      {/* How it works */}
      <section style={{ marginBottom: '3rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>How it works</h2>
        <ol style={{ color: 'var(--muted)', paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <li><code>GET /api/configs</code> → pick a launch option (config)</li>
          <li><code>POST /api/launch</code> → mint-partial-signed legacy transaction; add the payer signature and submit</li>
          <li><code>GET /api/pools</code> → find coins; a pool&apos;s <code>id</code> is the <code>poolAddress</code> for trades</li>
          <li><code>POST /api/trade/quote</code> then <code>POST /api/trade/tx</code> → unsigned legacy transaction; the owner signs and submits</li>
        </ol>
        <p style={{ color: 'var(--muted)', marginTop: '1rem', fontSize: '0.9rem' }}>
          Transactions are base64 legacy <code>Transaction</code>s. Sign and submit within ~90 seconds, or rebuild.
          Fees, creator share and cause routing differ per config: read them from <code>/api/configs</code>.
          Agents trade on their own; launching a new coin needs the user&apos;s confirmation unless they gave
          standing permission. Memecoins use the entry marked
          <code> defaultFor: [&quot;meme&quot;]</code>; see SKILL.md for fallbacks and geo behavior.
        </p>
      </section>

      {/* API reference */}
      <section style={{ marginBottom: '3rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>API reference</h2>

        <ApiEndpoint
          method="GET"
          path="/api/configs"
          description="Live launch catalog for this caller, geo verdict included."
          request={`(no body)`}
          response={`{
  "configs": [
    {
      "configKey": "...",
      "categories": ["meme"],
      "quote": { "mint": "...", "symbol": "...", "decimals": 6, "scaledUiAmountMultiplier": null, ... },
      "fees": { "label": "...", "details": [...], "curve": {...}, "postGraduation": {...},
                "creatorSharePct": 0, "allFeesToCause": false },
      "supportsCause": true,
      "supportsFirstBuy": true,
      "poolCreationFeeLamports": "0",
      "migrationQuoteThreshold": "...",
      "isStock": false,
      "defaultFor": ["meme"],
      "geo": { "allowed": true, "reason": null, "region": null, "byCategory": {...} },
      "decodeError": null
    }
  ]
}`}
        />

        <ApiEndpoint
          method="POST"
          path="/api/launch"
          description="Uploads image + metadata and builds the launch transaction on the chosen config."
          request={`{
  "configKey": "<configKey from /api/configs>",
  "category": "meme",            // meme | idea | startup
  "name": "My Token",
  "symbol": "MTK",
  "description": "...",
  "imageUrl": "https://...",     // or "image": base64
  "payerPublicKey": "<base58>",
  "donation": { "mode": "cause", "cause": "<slug>" },  // meme only
  "firstBuyAtoms": "0"           // optional
}`}
          response={`{
  "transaction": "<base64, mint-signed, payer unsigned>",
  "mintAddress": "...",
  "poolAddress": "...",
  "metadataUrl": "...",
  "imageUrl": "...",
  "configKey": "...",
  "category": "meme",
  "quoteMint": "...",
  "firstBuyAtoms": "0",
  "note": "..."
}`}
        />

        <ApiEndpoint
          method="POST"
          path="/api/trade/quote"
          description="Off-chain swap quote for a live curve pool."
          request={`{
  "poolAddress": "<pool id>",
  "side": "buy",                 // buy | sell
  "amountIn": "1000000",         // atoms: quote for buy, base for sell
  "slippageBps": 50              // optional, 0-10000
}`}
          response={`{
  "amountOut": "...",
  "minimumAmountOut": "...",
  "baseTransferFeeAtomics": "0",
  "consumedInput": "...",
  "amountLeft": "0",
  "amountIn": "1000000",
  "slippageBps": 50,
  "poolInfo": { "poolAddress", "configKey", "baseMint", "baseDecimals",
                "quoteMint", "quoteDecimals", "quoteSymbol", "quoteScaledUiAmount",
                "isQuoteSol", "baseTransferFee", "migrationState", "isCompleted" }
}`}
        />

        <ApiEndpoint
          method="POST"
          path="/api/trade/tx"
          description="Builds the unsigned swap transaction. Omit minimumAmountOut to quote internally; never send '0' (it disables slippage protection)."
          request={`{
  "poolAddress": "<pool id>",
  "ownerPublicKey": "<base58>",
  "side": "buy",
  "amountIn": "1000000",
  "minimumAmountOut": "<from quote>",  // optional
  "slippageBps": 50                    // optional
}`}
          response={`{
  "transaction": "<base64, unsigned>",
  "amountIn": "...",
  "minimumAmountOut": "...",
  "quote": { ... } | null,   // null when minimumAmountOut was supplied
  "poolInfo": { ... }
}`}
        />

        <ApiEndpoint
          method="GET"
          path="/api/pools"
          description="List or search coins. With search, list-only params are not forwarded and nextCursor is null."
          request={`?search=<name|symbol|mint>
&limit=20            // 1-100
&cursor=<nextCursor>
&tab=emerging        // emerging | graduated
&category=meme       // meme | idea | startup
&lifecycle=new
&sortBy=createdAt    // createdAt | createdAtAsc | volume24h | marketCap`}
          response={`{
  "pools": [
    {
      "id": "<pool address>",
      "name": "...", "symbol": "...", "baseMint": "...",
      "launchType": "meme",
      "price": 0.0012, "marketCap": 12345.6, "volume24h": 789,
      "quoteMint": "...", "quoteSymbol": "...",
      "graduated": false, "bondingCurve": 0.42,
      "configKey": "...", "createdAt": 1760000000000
    }
  ],
  "nextCursor": "<string | null>"
}`}
        />
      </section>

      {/* Migration */}
      <section style={{ marginBottom: '3rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>Migration states</h2>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
          Route on <code>poolInfo.migrationState</code>. <code>curve</code>: tradeable here.
          <code> migration_pending</code>: trade endpoints return <code>409</code> with <code>retryable: true</code>;
          retry later (nothing to route to yet). <code>migrated</code>: <code>409</code>, not retryable; trade on Jupiter.
        </p>
      </section>

      {/* Network note */}
      <section style={{ marginTop: '3rem', padding: '1rem 1.25rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
        <p style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>
          <strong style={{ color: 'var(--text)' }}>Network:</strong> Solana mainnet-beta.
          Pools run on Meteora&apos;s Dynamic Bonding Curve program <code>dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN</code>.
          SeekUplift is independent and not affiliated with or endorsed by Meteora.
        </p>
      </section>
    </main>
  )
}

function ApiEndpoint({
  method,
  path,
  description,
  request,
  response,
}: {
  method: string
  path: string
  description: string
  request: string
  response: string
}) {
  const methodColor = method === 'POST' ? '#f59e0b' : '#14f195'
  return (
    <div style={{ marginBottom: '2.5rem', borderTop: '1px solid var(--border)', paddingTop: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        <span style={{ color: methodColor, fontWeight: 700, fontFamily: 'monospace', fontSize: '0.875rem' }}>{method}</span>
        <code style={{ fontSize: '1rem', background: 'none', border: 'none', padding: 0 }}>{path}</code>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '1rem' }}>{description}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
        <div>
          <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '0.4rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Request</div>
          <pre style={{ margin: 0, fontSize: '0.8rem' }}>{request}</pre>
        </div>
        <div>
          <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '0.4rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Response</div>
          <pre style={{ margin: 0, fontSize: '0.8rem' }}>{response}</pre>
        </div>
      </div>
    </div>
  )
}
