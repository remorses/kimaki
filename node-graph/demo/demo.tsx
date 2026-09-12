import { NodeGraph, type GraphTree } from '../src/index.ts'

function NodeCard({
  kind,
  title,
  meta,
  status = 'online',
}: {
  kind: string
  title: string
  meta: string
  status?: 'online' | 'offline'
}) {
  return (
    <div className="node-card">
      <div className="node-kind">{kind}</div>
      <div className="node-title">{title}</div>
      <div className="node-meta">{meta}</div>
      <div className={`node-status ${status}`}>{status}</div>
    </div>
  )
}

const oneServerTree: GraphTree = {
  id: 'gateway',
  width: 220,
  height: 132,
  content: (
    <NodeCard
      kind="Gateway"
      title="kimaki-gateway"
      meta="wss://gateway.kimaki.dev"
    />
  ),
  children: [
    {
      id: 'server-1',
      width: 220,
      height: 132,
      content: (
        <NodeCard kind="Kimaki server" title="studio.local" meta="1 guild" />
      ),
    },
  ],
}

const threeServerTree: GraphTree = {
  id: 'gateway',
  width: 220,
  height: 132,
  content: (
    <NodeCard
      kind="Gateway"
      title="kimaki-gateway"
      meta="wss://gateway.kimaki.dev"
    />
  ),
  children: [
    {
      id: 'server-1',
      width: 220,
      height: 132,
      content: (
        <NodeCard kind="Kimaki server" title="studio.local" meta="2 guilds" />
      ),
    },
    {
      id: 'server-2',
      width: 220,
      height: 132,
      content: (
        <NodeCard kind="Kimaki server" title="office-mac" meta="1 guild" />
      ),
    },
    {
      id: 'server-3',
      width: 220,
      height: 132,
      content: (
        <NodeCard
          kind="Kimaki server"
          title="ci-box"
          meta="unreachable"
          status="offline"
        />
      ),
    },
  ],
}

export function Demo() {
  return (
    <div className="demo-page">
      <header className="demo-header">
        <h1>Read-only node graph</h1>
        <p>Drag nodes. Connections stay fixed. Click does not spawn nodes.</p>
      </header>
      <section>
        <p className="node-kind" style={{ marginBottom: 12 }}>
          1 gateway, 1 kimaki server
        </p>
        <div data-testid="graph-one">
          <NodeGraph tree={oneServerTree} className="demo-stage" />
        </div>
      </section>
      <section>
        <p className="node-kind" style={{ marginBottom: 12 }}>
          1 gateway, 3 kimaki servers
        </p>
        <div data-testid="graph-three">
          <NodeGraph tree={threeServerTree} className="demo-stage" />
        </div>
      </section>
    </div>
  )
}
