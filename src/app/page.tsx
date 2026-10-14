export default function Home() {
  return (
    <main style={{ maxWidth: 860, margin: '0 auto', padding: '3rem 1.5rem 6rem' }}>
      {/* Header */}
      <div style={{ marginBottom: '3rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
          <span style={{ fontSize: '1.5rem' }}>⚡</span>
          <span style={{ color: 'var(--muted)', fontSize: '0.875rem', fontWeight: 500, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            Meteora Launchpad
          </span>
        </div>
        <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3rem)', lineHeight: 1.1, marginBottom: '1rem' }}>
          Agentic API
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: '1.125rem', maxWidth: 600 }}>
          Launch tokens where <strong style={{ color: 'var(--accent2)' }}>every trade funds something that matters</strong>.
          0.5% of every trading fee flows to public benefit or innovation. Creators earn 0.3% forever.
          Built on audited Meteora DBC infrastructure — your agent signs, submits, and makes an impact.
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

      {/* Why this launchpad */}
      <section style={{ marginBottom: '3rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Why launch here?</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
          {[
            {
              icon: '🌱',
              title: 'Meaningful',
              body: '0.5% of every trading fee goes to public benefit or innovation funding — impact built into every trade.',
              highlight: true,
            },
            {
              icon: '💰',
              title: 'Rewarding',
              body: 'Creators keep a 0.3% fee on every trade of their token — a lasting reward for launching something great.',
              highlight: false,
            },
            {
              icon: '🔒',
              title: 'Secure',
              body: 'Powered by the audited Meteora DBC program — battle-tested on-chain infrastructure you can trust.',
              highlight: false,
            },
            {
              icon: '📱',
              title: 'Seeker-Friendly',
              body: 'Trade with SKR using your self-custodied Seeker wallet — your keys, your assets, your control.',
              highlight: false,
            },
          ].map((v) => (
            <div
              key={v.title}
              style={{
                background: v.highlight ? 'rgba(20, 241, 149, 0.06)' : 'var(--surface)',
                border: `1px solid ${v.highlight ? 'rgba(20, 241, 149, 0.25)' : 'var(--border)'}`,
                borderRadius: 'var(--radius)',
                padding: '1.25rem',
              }}
            >
              <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>{v.icon}</div>
              <div style={{ fontWeight: 600, marginBottom: '0.4rem', color: v.highlight ? 'var(--accent2)' : 'var(--text)' }}>
                {v.title}
                {v.highlight && <span style={{ marginLeft: '0.4rem', fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--accent2)', opacity: 0.8 }}>Core mission</span>}
              </div>
              <div style={{ color: 'var(--muted)', fontSize: '0.875rem', lineHeight: 1.5 }}>{v.body}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Capabilities */}
      <section style={{ marginBottom: '3rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Capabilities</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
          {[
            { icon: '🚀', title: 'Launch Token', desc: 'Upload image + metadata through the backend proxy, get an unsigned createPool transaction on a config you choose.' },
            { icon: '💸', title: 'Buy', desc: 'Quote and build an unsigned swap transaction to buy a bonding-curve token.' },
            { icon: '🔄', title: 'Sell', desc: 'Quote and build an unsigned swap transaction to sell back to the curve.' },
            { icon: '🔍', title: 'List Pools', desc: 'Search and browse tokens launched on this launchpad.' },
          ].map((c) => (
            <div key={c.title} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '1.25rem' }}>
              <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>{c.icon}</div>
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{c.title}</div>
              <div style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>{c.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section style={{ marginBottom: '3rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>How it works</h2>
        <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>
          All write operations follow a <strong style={{ color: 'var(--text)' }}>prepare → sign → submit</strong> pattern.
          The API returns a base64-encoded, partially-signed Solana transaction.
          Your agent deserializes it, adds the payer signature, and submits to any mainnet RPC.
        </p>
        <ol style={{ color: 'var(--muted)', paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <li>Call <code>POST /api/launch</code> or <code>POST /api/trade/tx</code> → receive <code>transaction</code> (base64)</li>
          <li>Decode from base64 → deserialize as a <code>Transaction</code> (legacy)</li>
          <li>Sign with your payer keypair</li>
          <li>Submit via <code>sendRawTransaction</code> to <code>https://api.mainnet-beta.solana.com</code></li>
        </ol>
      </section>

      {/* Quick start */}
      <section style={{ marginBottom: '3rem' }}>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>Quick Start</h2>
        <p style={{ color: 'var(--muted)', marginBottom: '1rem', fontSize: '0.9rem' }}>Launch a token in ~10 lines of JS:</p>
        <pre>{`import { Connection, Keypair, Transaction } from '@solana/web3.js'

const AGENT_API = 'https://your-agent-site.com'

// 1. Prepare the launch transaction
const res = await fetch(\`\${AGENT_API}/api/launch\`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'My Agent Token',
    symbol: 'AGT',
    description: 'Launched by an AI agent',
    configKey: '61UBwyZfNnULczb3teQx9FkxvfAH4WdESfZ23MRThQAv', // from GET /api/configs
    category: 'meme',
    image: logoPngBase64,     // base64 image bytes (PNG/JPEG/GIF/WEBP)
    payerPublicKey: payer.publicKey.toBase58(),
    // donation: { mode: 'cause', cause: '…' }  // meme on cause-capable configs
    // firstBuyAmount: '100'                   // optional creator first buy, quote display units
  }),
})
const { transaction, mintAddress } = await res.json()

// 2. Sign with payer
const tx = Transaction.from(Buffer.from(transaction, 'base64'))
tx.partialSign(payer)

// 3. Submit
const connection = new Connection('https://api.mainnet-beta.solana.com')
const sig = await connection.sendRawTransaction(tx.serialize())
console.log('Launched:', mintAddress, 'tx:', sig)`}</pre>
      </section>

      {/* API Reference */}
      <section>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '1.5rem' }}>API Reference</h2>

        <ApiEndpoint
          method="POST"
          path="/api/launch"
          description="Upload image + metadata through the backend proxy and build an unsigned createPool transaction on a config from GET /api/configs."
          request={`{
  "configKey": "61UBwyZf…",    // required — a live config from GET /api/configs
  "category": "meme",          // required — "meme" | "idea" | "startup"; the config
                             //   must be offered for it (see its categories[])
  "name": "My Token",          // required, ≥3 chars / ≤32 UTF-8 bytes
  "symbol": "MTK",             // required, ≤10 UTF-8 bytes (canonicalized:
                             //   leading "$" stripped, uppercased)
  "description": "…",          // required, ≤2000 chars
  "image": "<base64>",         // required — PNG/JPEG/GIF/WEBP bytes as base64
                             //   (a data: URL works too); uploaded via the
                             //   backend proxy. "imageUrl" is rejected.
  "payerPublicKey": "...",     // required, base58 Solana public key — signs + funds
  "donation": {                // meme-only; only on cause-capable configs;
    "mode": "cause",           //   REQUIRED while /api/causes offers picks.
    "cause": "education"       //   mode ∈ cause-funding launch modes
  },                           //   (managed|cause|project|tbd); cause → slug,
                               //   project → bare Giveth id, tbd/managed → {}
  "ideaFunding": {             // idea-only: mode ∈ idea-funding launch modes
    "mode": "direct",          //   (direct|tbd|x|reddit); direct → on-curve
    "address": "..."           //   address; x → handle; reddit → handle+userId
  },
  "firstBuyAtoms": "1000000",  // OR "firstBuyAmount": "1.0" in display units;
                               //   only on supportsFirstBuy configs. Display
                               //   amounts convert via quote decimals + the
                               //   ScaledUiAmount multiplier (never 1e9).
  // idea/startup extras: problem, useCases (1–3 catalog slugs), prototype
  //   (idea, required), deck (startup, required), whitepaper
  // links: website, twitter, telegram, discord
  // startup compliance: startupComplianceAcknowledged, legalFramework,
  //   legalFrameworkNote, tokenUtility, decentralizationEfforts,
  //   entityJurisdiction
}`}
          response={`{
  "transaction": "...",    // base64 legacy Transaction, partially signed by mint keypair
  "mintAddress": "...",    // new token mint public key
  "poolAddress": "...",    // derived DBC pool PDA
  "metadataUrl": "...",    // IPFS metadata URL
  "imageUrl": "...",       // IPFS image URL
  "configKey": "61UBwyZf…",
  "category": "meme",
  "quoteMint": "SKRbvo6G…",
  "firstBuyAtoms": "1000000",  // echo when a first buy was bundled, else null
  "note": "Sign with payerPublicKey then submit to mainnet RPC"
}`}
        />

        <ApiEndpoint
          method="POST"
          path="/api/trade/quote"
          description="Get an off-chain swap quote from the bonding curve (no transaction built)."
          request={`{
  "poolAddress": "...",   // required, DBC pool public key
  "side": "buy",          // required, "buy" or "sell"
  "amountIn": "1000000",  // required, string integer in base units
                          //   buy: lamports of SOL (or quote token atoms)
                          //   sell: token atoms
  "slippageBps": 50       // optional, default 50 (0.5%)
}`}
          response={`{
  "amountOut": "987654",
  "minimumAmountOut": "982654",
  "poolInfo": {
    "quoteMint": "So111...",
    "quoteSymbol": "SOL",
    "isQuoteSol": true,
    "isCompleted": false    // true = pool graduated to AMM (use Jupiter instead)
  }
}`}
        />

        <ApiEndpoint
          method="POST"
          path="/api/trade/tx"
          description="Build an unsigned swap transaction. Get a quote first, pass minimumAmountOut here."
          request={`{
  "poolAddress": "...",
  "side": "buy",            // "buy" or "sell"
  "amountIn": "1000000",
  "minimumAmountOut": "982654",
  "ownerPublicKey": "..."   // base58 — the wallet that will sign and pay
}`}
          response={`{
  "transaction": "...",   // base64 legacy Transaction — sign with ownerPublicKey
  "note": "Sign with ownerPublicKey then submit to mainnet RPC"
}`}
        />

        <ApiEndpoint
          method="GET"
          path="/api/pools?search=&limit=20"
          description="List or search tokens launched on this launchpad."
          request={`// Query params:
// search (optional) — text search by name or symbol
// limit  (optional) — max results, default 20`}
          response={`{
  "pools": [
    {
      "id": "pool_address",
      "name": "Token Name",
      "symbol": "SYM",
      "baseMint": "mint_address",
      "price": 0.0000123,
      "marketCap": 12345.67,
      "volume24h": 5000.0,
      "priceChange24h": 12.5,
      "graduated": false,
      "createdAt": 1712345678000
    }
  ]
}`}
        />
      </section>

      {/* Network note */}
      <section style={{ marginTop: '3rem', padding: '1rem 1.25rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
        <p style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>
          <strong style={{ color: 'var(--text)' }}>Network:</strong> Mainnet only.
          DBC config key: <code>4w9Rs2ewNJte2c4FGmQHM8fycv8vWzkjv3qzANuJ2rPT</code>.
          Program: <code>dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN</code>.
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
