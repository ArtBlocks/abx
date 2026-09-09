'use client';

import {useState} from 'react';
import styles from './architecture-diagram.module.css';

type Mode = 'onchain' | 'resolver';

export function ArchitectureDiagram() {
  const [mode, setMode] = useState<Mode>('onchain');

  return (
    <div className={styles.wrap}>
      <div className={styles.tabs} role="tablist" aria-label="tokenURI resolution mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'onchain'}
          className={`${styles.tab} ${mode === 'onchain' ? styles.tabOn : ''}`}
          onClick={() => setMode('onchain')}
        >
          Onchain
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'resolver'}
          className={`${styles.tab} ${mode === 'resolver' ? styles.tabOn : ''}`}
          onClick={() => setMode('resolver')}
        >
          Resolver
        </button>
      </div>

      <div className={styles.stage}>
        {mode === 'onchain' ? <OnChain /> : <Resolver />}
      </div>
    </div>
  );
}

function Node({
  title,
  sub,
  accent,
}: {
  title: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className={`${styles.node} ${accent ? styles.nodeAccent : ''}`}>
      <div className={styles.nodeTitle}>{title}</div>
      {sub && <div className={styles.nodeSub}>{sub}</div>}
    </div>
  );
}

function Edge({ label }: { label?: string }) {
  return (
    <div className={styles.edge}>
      {label && <span className={styles.edgeLabel}>{label}</span>}
    </div>
  );
}

function OnChain() {
  return (
    <>
      <div className={styles.row}>
        <Node title="Project owner" />
        <Edge label="deploy, configure" />
        <Node title="ABX contract" sub="fields + on-chain renderer" accent />
        <Edge label="tokenURI: one eth_call" />
        <Node title="Wallet / marketplace" />
      </div>
      <p className={styles.caption}>
        The contract assembles <b>tokenURI</b> from its own fields. Resolution takes one <b>eth_call</b>.
      </p>
    </>
  );
}

type NodeKey = 'owner' | 'contract' | 'resolver' | 'effects' | 'storage' | 'consumer';

const POS: Record<NodeKey, {x: number; y: number}> = {
  owner: {x: 18, y: 14},
  contract: {x: 58, y: 14},
  resolver: {x: 28, y: 52},
  effects: {x: 80, y: 52},
  storage: {x: 80, y: 88},
  consumer: {x: 28, y: 88},
};

const NODE_CONTENT: Record<NodeKey, {title: string; sub?: string; accent?: boolean}> = {
  owner: {title: 'Project owner'},
  contract: {title: 'ABX contract', accent: true},
  resolver: {title: 'Resolver', sub: 'off-chain, read-only index'},
  effects: {title: 'Effects runner'},
  storage: {title: 'Storage', sub: 'IPFS · Arweave · S3'},
  consumer: {title: 'tokenURI JSON', sub: '→ wallet / marketplace', accent: true},
};

const EDGES: {from: NodeKey; to: NodeKey; label: string; labelAt?: {x: number; y: number}}[] = [
  {from: 'owner', to: 'contract', label: 'deploy, configure, mint', labelAt: {x: 38, y: 4}},
  {from: 'contract', to: 'resolver', label: 'event log'},
  {from: 'contract', to: 'effects', label: 'event log'},
  {from: 'effects', to: 'resolver', label: 'publishes renders'},
  {from: 'effects', to: 'storage', label: 'read / write bytes'},
  {from: 'resolver', to: 'consumer', label: 'tokenURI JSON'},
];

function Resolver() {
  return (
    <>
      <div className={styles.canvas}>
        <svg className={styles.svgLayer} viewBox="0 0 100 100" preserveAspectRatio="none">
          {EDGES.map((e, i) => {
            const a = POS[e.from];
            const b = POS[e.to];
            return (
              <path key={i} className={styles.edgePath} d={`M ${a.x} ${a.y} L ${b.x} ${b.y}`} />
            );
          })}
        </svg>

        {EDGES.map((e, i) => {
          const a = POS[e.from];
          const b = POS[e.to];
          const pos = e.labelAt ?? {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
          return (
            <span key={i} className={styles.canvasLabel} style={{left: `${pos.x}%`, top: `${pos.y}%`}}>
              {e.label}
            </span>
          );
        })}

        {(Object.keys(POS) as NodeKey[]).map((key) => (
          <div
            key={key}
            className={styles.canvasNode}
            style={{left: `${POS[key].x}%`, top: `${POS[key].y}%`}}
          >
            <Node {...NODE_CONTENT[key]} />
          </div>
        ))}
      </div>
      <p className={styles.caption}>
        The resolver replays events, reads contract fields, and fetches remote bytes. A resolver-served
        project can still keep any field onchain.
      </p>
    </>
  );
}
