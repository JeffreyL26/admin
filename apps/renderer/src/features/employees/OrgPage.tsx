import React, { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Building2, Check, Download, MapPin, Network, Pencil, Plus, Trash2, Users, X,
} from 'lucide-react';
import { BUNDESLAND_LABELS, type BundeslandCode } from '@hrmonic/shared';
import { api } from '../../api/client';
import { Badge, Card, EmptyState, Field, PageHeader, Spinner, Tabs } from '../../components/ui';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { EmployeeSelect } from '../../components/EmployeeSelect';
import { useLocations, useOrgTree, type Location, type OrgTreeNode } from './api';

type DragPayload = { kind: 'department' | 'team'; id: number };

export function OrgPage() {
  const [tab, setTab] = useState('struktur');
  return (
    <>
      <PageHeader
        title="Organisation"
        subtitle="Abteilungen, Teams und Standorte — Struktur per Drag-and-Drop anpassen."
      />
      <Tabs
        tabs={[
          { key: 'struktur', label: 'Struktur' },
          { key: 'organigramm', label: 'Organigramm' },
          { key: 'standorte', label: 'Standorte' },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div style={{ marginTop: 16 }}>
        {tab === 'struktur' && <StructureTab />}
        {tab === 'organigramm' && <OrgChartTab />}
        {tab === 'standorte' && <LocationsTab />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Struktur-Baum mit Drag-and-Drop
// ---------------------------------------------------------------------------

function useOrgMutations() {
  const toast = useToast();
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['org'] });
    qc.invalidateQueries({ queryKey: ['employees'] });
  };
  const onError = (e: Error) => toast.error(e.message);

  return {
    createDepartment: useMutation({
      mutationFn: (body: { name: string; parent_id: number | null }) => api.post('/api/departments', body),
      onSuccess: () => {
        invalidate();
        toast.success('Abteilung angelegt');
      },
      onError,
    }),
    patchDepartment: useMutation({
      mutationFn: ({ id, ...body }: { id: number } & Record<string, unknown>) =>
        api.patch(`/api/departments/${id}`, body),
      onSuccess: () => {
        invalidate();
        toast.success('Abteilung aktualisiert');
      },
      onError,
    }),
    deleteDepartment: useMutation({
      mutationFn: (id: number) => api.delete(`/api/departments/${id}`),
      onSuccess: () => {
        invalidate();
        toast.success('Abteilung gelöscht');
      },
      onError,
    }),
    createTeam: useMutation({
      mutationFn: (body: { name: string; department_id: number | null }) => api.post('/api/teams', body),
      onSuccess: () => {
        invalidate();
        toast.success('Team angelegt');
      },
      onError,
    }),
    patchTeam: useMutation({
      mutationFn: ({ id, ...body }: { id: number } & Record<string, unknown>) => api.patch(`/api/teams/${id}`, body),
      onSuccess: () => {
        invalidate();
        toast.success('Team aktualisiert');
      },
      onError,
    }),
    deleteTeam: useMutation({
      mutationFn: (id: number) => api.delete(`/api/teams/${id}`),
      onSuccess: () => {
        invalidate();
        toast.success('Team gelöscht');
      },
      onError,
    }),
  };
}

function InlineNameEditor({
  initial,
  onSave,
  onCancel,
  placeholder,
}: {
  initial: string;
  onSave: (name: string) => void;
  onCancel: () => void;
  placeholder?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <span className="row" style={{ gap: 6 }}>
      <input
        className="hm-input"
        style={{ height: 30, width: 200 }}
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) onSave(value.trim());
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button
        className="hm-btn hm-btn--primary hm-btn--sm hm-btn--icon"
        disabled={!value.trim()}
        onClick={() => onSave(value.trim())}
        title="Speichern"
      >
        <Check size={14} />
      </button>
      <button className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon" onClick={onCancel} title="Abbrechen">
        <X size={14} />
      </button>
    </span>
  );
}

function StructureTab() {
  const { data, isLoading } = useOrgTree();
  const m = useOrgMutations();
  const [creatingRoot, setCreatingRoot] = useState(false);
  const [dropTarget, setDropTarget] = useState<number | 'root' | null>(null);

  const handleDrop = (target: number | null, payload: DragPayload) => {
    if (payload.kind === 'department') {
      m.patchDepartment.mutate({ id: payload.id, parent_id: target });
    } else if (target !== null) {
      m.patchTeam.mutate({ id: payload.id, department_id: target });
    }
  };

  if (isLoading || !data) return <Spinner center />;

  return (
    <Card
      title="Abteilungen & Teams"
      actions={
        creatingRoot ? (
          <InlineNameEditor
            initial=""
            placeholder="Name der Abteilung"
            onSave={(name) => {
              m.createDepartment.mutate({ name, parent_id: null });
              setCreatingRoot(false);
            }}
            onCancel={() => setCreatingRoot(false)}
          />
        ) : (
          <button className="hm-btn hm-btn--primary hm-btn--sm" onClick={() => setCreatingRoot(true)}>
            <Plus size={15} /> Abteilung
          </button>
        )
      }
    >
      {data.tree.length === 0 ? (
        <EmptyState
          icon={<Building2 size={40} />}
          title="Noch keine Organisationsstruktur"
          hint="Legen Sie die erste Abteilung an — Teams und Unterabteilungen folgen darunter."
        />
      ) : (
        <>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDropTarget('root');
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDropTarget(null);
              try {
                const payload = JSON.parse(e.dataTransfer.getData('application/json')) as DragPayload;
                if (payload.kind === 'department') handleDrop(null, payload);
              } catch {
                /* fremdes Drag-Objekt ignorieren */
              }
            }}
            style={{
              border: `1px dashed ${dropTarget === 'root' ? 'var(--brand-primary)' : 'var(--border-strong)'}`,
              borderRadius: 8,
              padding: '6px 12px',
              marginBottom: 12,
              fontSize: 'var(--text-sm)',
              color: 'var(--text-muted)',
            }}
          >
            Hierhin ziehen, um eine Abteilung auf die oberste Ebene zu verschieben
          </div>
          <div className="stack" style={{ gap: 4 }}>
            {data.tree.map((node) => (
              <DepartmentNode
                key={node.id}
                node={node}
                depth={0}
                dropTarget={dropTarget}
                setDropTarget={setDropTarget}
                onDropNode={handleDrop}
                mutations={m}
              />
            ))}
          </div>
          {data.unassigned_count > 0 && (
            <p style={{ marginTop: 14, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              {data.unassigned_count} aktive Mitarbeitende ohne Abteilungszuordnung.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function DepartmentNode({
  node,
  depth,
  dropTarget,
  setDropTarget,
  onDropNode,
  mutations,
}: {
  node: OrgTreeNode;
  depth: number;
  dropTarget: number | 'root' | null;
  setDropTarget: (t: number | 'root' | null) => void;
  onDropNode: (target: number | null, payload: DragPayload) => void;
  mutations: ReturnType<typeof useOrgMutations>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [addingChild, setAddingChild] = useState<'department' | 'team' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [headOpen, setHeadOpen] = useState(false);
  const [head, setHead] = useState<number | null>(node.head_employee_id);

  return (
    <div style={{ marginLeft: depth * 26 }}>
      <div
        className="row"
        draggable={!renaming}
        onDragStart={(e) =>
          e.dataTransfer.setData('application/json', JSON.stringify({ kind: 'department', id: node.id }))
        }
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDropTarget(node.id);
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDropTarget(null);
          try {
            const payload = JSON.parse(e.dataTransfer.getData('application/json')) as DragPayload;
            if (payload.kind === 'department' && payload.id === node.id) return;
            onDropNode(node.id, payload);
          } catch {
            /* ignorieren */
          }
        }}
        style={{
          padding: '7px 10px',
          borderRadius: 8,
          border: `1px solid ${dropTarget === node.id ? 'var(--brand-primary)' : 'var(--border)'}`,
          background: dropTarget === node.id ? 'var(--blue-50)' : 'var(--bg-surface)',
          cursor: 'grab',
        }}
      >
        <Building2 size={16} style={{ color: 'var(--brand-primary)', flexShrink: 0 }} />
        {renaming ? (
          <InlineNameEditor
            initial={node.name}
            onSave={(name) => {
              mutations.patchDepartment.mutate({ id: node.id, name });
              setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span style={{ fontWeight: 600 }}>{node.name}</span>
        )}
        <Badge tone="blue">
          <Users size={12} /> {node.total_employee_count}
        </Badge>
        {node.head_name && (
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Leitung: {node.head_name}</span>
        )}
        <span style={{ flex: 1 }} />
        <button className="hm-btn hm-btn--ghost hm-btn--sm" title="Leitung festlegen" onClick={() => setHeadOpen(true)}>
          Leitung
        </button>
        <button
          className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
          title="Umbenennen"
          onClick={() => setRenaming(true)}
        >
          <Pencil size={14} />
        </button>
        <button
          className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
          title="Unterabteilung anlegen"
          onClick={() => setAddingChild('department')}
        >
          <Plus size={14} />
        </button>
        <button
          className="hm-btn hm-btn--ghost hm-btn--sm"
          title="Team anlegen"
          onClick={() => setAddingChild('team')}
        >
          <Plus size={13} /> Team
        </button>
        <button
          className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
          title="Löschen"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 size={14} />
        </button>
      </div>

      {addingChild && (
        <div style={{ marginLeft: 26, marginTop: 6 }}>
          <InlineNameEditor
            initial=""
            placeholder={addingChild === 'department' ? 'Name der Unterabteilung' : 'Name des Teams'}
            onSave={(name) => {
              if (addingChild === 'department') {
                mutations.createDepartment.mutate({ name, parent_id: node.id });
              } else {
                mutations.createTeam.mutate({ name, department_id: node.id });
              }
              setAddingChild(null);
            }}
            onCancel={() => setAddingChild(null)}
          />
        </div>
      )}

      {node.teams.map((team) => (
        <TeamNode key={team.id} team={team} mutations={mutations} />
      ))}

      {node.children.map((child) => (
        <DepartmentNode
          key={child.id}
          node={child}
          depth={depth + 1}
          dropTarget={dropTarget}
          setDropTarget={setDropTarget}
          onDropNode={onDropNode}
          mutations={mutations}
        />
      ))}

      <ConfirmDialog
        open={confirmDelete}
        title="Abteilung löschen?"
        message={`„${node.name}“ wird gelöscht. Zugeordnete Teams und Mitarbeitende verlieren ihre Abteilungszuordnung.`}
        onConfirm={() => mutations.deleteDepartment.mutate(node.id)}
        onClose={() => setConfirmDelete(false)}
      />
      <Modal
        title={`Leitung von „${node.name}“`}
        open={headOpen}
        onClose={() => setHeadOpen(false)}
        footer={
          <>
            <button className="hm-btn hm-btn--secondary" onClick={() => setHeadOpen(false)}>
              Abbrechen
            </button>
            <button
              className="hm-btn hm-btn--primary"
              onClick={() => {
                mutations.patchDepartment.mutate({ id: node.id, head_employee_id: head });
                setHeadOpen(false);
              }}
            >
              Speichern
            </button>
          </>
        }
      >
        <Field label="Abteilungsleitung">
          <EmployeeSelect value={head} onChange={setHead} allowEmpty emptyLabel="— keine —" />
        </Field>
      </Modal>
    </div>
  );
}

function TeamNode({
  team,
  mutations,
}: {
  team: OrgTreeNode['teams'][number];
  mutations: ReturnType<typeof useOrgMutations>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div
      className="row"
      draggable={!renaming}
      onDragStart={(e) =>
        e.dataTransfer.setData('application/json', JSON.stringify({ kind: 'team', id: team.id }))
      }
      style={{
        marginLeft: 26,
        marginTop: 4,
        padding: '5px 10px',
        borderRadius: 8,
        border: '1px dashed var(--border)',
        cursor: 'grab',
      }}
    >
      <Network size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
      {renaming ? (
        <InlineNameEditor
          initial={team.name}
          onSave={(name) => {
            mutations.patchTeam.mutate({ id: team.id, name });
            setRenaming(false);
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <span>{team.name}</span>
      )}
      <Badge tone="neutral">
        <Users size={12} /> {team.employee_count}
      </Badge>
      {team.lead_name && (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Lead: {team.lead_name}</span>
      )}
      <span style={{ flex: 1 }} />
      <button
        className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
        title="Umbenennen"
        onClick={() => setRenaming(true)}
      >
        <Pencil size={13} />
      </button>
      <button
        className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
        title="Löschen"
        onClick={() => setConfirmDelete(true)}
      >
        <Trash2 size={13} />
      </button>
      <ConfirmDialog
        open={confirmDelete}
        title="Team löschen?"
        message={`„${team.name}“ wird gelöscht. Mitarbeitende verlieren ihre Teamzuordnung.`}
        onConfirm={() => mutations.deleteTeam.mutate(team.id)}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Organigramm (SVG, hierarchisch) + Export
// ---------------------------------------------------------------------------

const NODE_W = 200;
const NODE_H = 74;
const H_GAP = 24;
const V_GAP = 60;

interface LaidOutNode {
  node: OrgTreeNode;
  x: number;
  y: number;
}

function layoutTree(roots: OrgTreeNode[]): { nodes: LaidOutNode[]; edges: [LaidOutNode, LaidOutNode][]; width: number; height: number } {
  const nodes: LaidOutNode[] = [];
  const edges: [LaidOutNode, LaidOutNode][] = [];
  let maxDepth = 0;

  const subtreeWidth = (n: OrgTreeNode): number => {
    if (n.children.length === 0) return NODE_W + H_GAP;
    return Math.max(NODE_W + H_GAP, n.children.reduce((acc, c) => acc + subtreeWidth(c), 0));
  };

  const place = (n: OrgTreeNode, left: number, depth: number): LaidOutNode => {
    maxDepth = Math.max(maxDepth, depth);
    const width = subtreeWidth(n);
    const self: LaidOutNode = {
      node: n,
      x: left + width / 2 - NODE_W / 2,
      y: depth * (NODE_H + V_GAP),
    };
    nodes.push(self);
    let childLeft = left;
    for (const child of n.children) {
      const childNode = place(child, childLeft, depth + 1);
      edges.push([self, childNode]);
      childLeft += subtreeWidth(child);
    }
    return self;
  };

  let left = 0;
  for (const root of roots) {
    place(root, left, 0);
    left += subtreeWidth(root);
  }
  return { nodes, edges, width: Math.max(left, NODE_W + H_GAP), height: (maxDepth + 1) * (NODE_H + V_GAP) };
}

function OrgChartTab() {
  const { data, isLoading } = useOrgTree();
  const toast = useToast();
  const svgRef = useRef<SVGSVGElement>(null);

  if (isLoading || !data) return <Spinner center />;
  if (data.tree.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Network size={40} />}
          title="Kein Organigramm möglich"
          hint="Legen Sie zuerst Abteilungen im Tab „Struktur“ an."
        />
      </Card>
    );
  }

  const { nodes, edges, width, height } = layoutTree(data.tree);

  const exportSvg = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'organigramm.svg';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success('Organigramm als SVG exportiert');
  };

  return (
    <Card
      title="Organigramm"
      actions={
        <button className="hm-btn hm-btn--secondary hm-btn--sm" onClick={exportSvg}>
          <Download size={15} /> SVG exportieren
        </button>
      }
    >
      <div className="hm-table-wrap">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          style={{ maxWidth: '100%', height: 'auto', fontFamily: 'Inter, system-ui, sans-serif' }}
        >
          {edges.map(([from, to], i) => (
            <path
              key={i}
              d={`M ${from.x + NODE_W / 2} ${from.y + NODE_H}
                  C ${from.x + NODE_W / 2} ${from.y + NODE_H + V_GAP / 2},
                    ${to.x + NODE_W / 2} ${to.y - V_GAP / 2},
                    ${to.x + NODE_W / 2} ${to.y}`}
              fill="none"
              stroke="#c3cede"
              strokeWidth={1.5}
            />
          ))}
          {nodes.map(({ node, x, y }) => (
            <g key={node.id}>
              <rect x={x} y={y} width={NODE_W} height={NODE_H} rx={10} fill="#ffffff" stroke="#d4dce6" />
              <rect x={x} y={y} width={4} height={NODE_H} rx={2} fill="#0864c6" />
              <text x={x + 14} y={y + 22} fontSize={13} fontWeight={700} fill="#16232f">
                {node.name.length > 24 ? `${node.name.slice(0, 23)}…` : node.name}
              </text>
              <text x={x + 14} y={y + 41} fontSize={11} fill="#5b6b7c">
                {node.head_name ? `Leitung: ${node.head_name}` : 'Leitung offen'}
              </text>
              <text x={x + 14} y={y + 59} fontSize={11} fill="#5b6b7c">
                {node.total_employee_count} Mitarbeitende · {node.teams.length} Teams
              </text>
            </g>
          ))}
        </svg>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Standorte
// ---------------------------------------------------------------------------

function LocationsTab() {
  const { data: locations, isLoading } = useLocations();
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Location | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Location | null>(null);

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/locations/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org'] });
      toast.success('Standort gelöscht');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <Spinner center />;

  return (
    <Card
      title="Standorte"
      flush
      actions={
        <button className="hm-btn hm-btn--primary hm-btn--sm" onClick={() => setCreateOpen(true)}>
          <Plus size={15} /> Standort
        </button>
      }
    >
      {(locations?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<MapPin size={40} />}
          title="Noch keine Standorte"
          hint="Das Bundesland des Standorts steuert die Feiertagsberechnung der zugeordneten Mitarbeitenden."
        />
      ) : (
        <div className="hm-table-wrap">
          <table className="hm-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Adresse</th>
                <th>Bundesland</th>
                <th className="num">Mitarbeitende</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {locations!.map((l) => (
                <tr key={l.id}>
                  <td style={{ fontWeight: 600 }}>{l.name}</td>
                  <td>{[l.street, [l.zip, l.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '—'}</td>
                  <td>
                    <Badge tone="navy">{BUNDESLAND_LABELS[l.bundesland as BundeslandCode] ?? l.bundesland}</Badge>
                  </td>
                  <td className="num">{l.employee_count ?? 0}</td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button
                        className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                        title="Bearbeiten"
                        onClick={() => setEditing(l)}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        className="hm-btn hm-btn--ghost hm-btn--sm hm-btn--icon"
                        title="Löschen"
                        onClick={() => setConfirmDelete(l)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <LocationModal open={createOpen} location={null} onClose={() => setCreateOpen(false)} />
      <LocationModal open={editing !== null} location={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Standort löschen?"
        message={`„${confirmDelete?.name}“ wird gelöscht. Mitarbeitende verlieren ihre Standortzuordnung.`}
        onConfirm={() => confirmDelete && remove.mutate(confirmDelete.id)}
        onClose={() => setConfirmDelete(null)}
      />
    </Card>
  );
}

function LocationModal({
  open,
  location,
  onClose,
}: {
  open: boolean;
  location: Location | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', street: '', zip: '', city: '', bundesland: 'BY' });

  React.useEffect(() => {
    if (open) {
      setForm({
        name: location?.name ?? '',
        street: location?.street ?? '',
        zip: location?.zip ?? '',
        city: location?.city ?? '',
        bundesland: location?.bundesland ?? 'BY',
      });
    }
  }, [open, location]);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name.trim(),
        street: form.street.trim() || null,
        zip: form.zip.trim() || null,
        city: form.city.trim() || null,
        bundesland: form.bundesland,
      };
      return location ? api.patch(`/api/locations/${location.id}`, payload) : api.post('/api/locations', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org'] });
      toast.success(location ? 'Standort aktualisiert' : 'Standort angelegt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Modal
      title={location ? `Standort „${location.name}“ bearbeiten` : 'Standort anlegen'}
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="hm-btn hm-btn--secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="hm-btn hm-btn--primary"
            disabled={!form.name.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            Speichern
          </button>
        </>
      }
    >
      <div className="hm-form-grid">
        <Field label="Name" required span2>
          <input className="hm-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Straße und Hausnummer" span2>
          <input className="hm-input" value={form.street} onChange={(e) => setForm({ ...form, street: e.target.value })} />
        </Field>
        <Field label="PLZ">
          <input className="hm-input" value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} />
        </Field>
        <Field label="Ort">
          <input className="hm-input" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        </Field>
        <Field label="Bundesland" required hint="Steuert die Feiertagsberechnung">
          <select
            className="hm-select"
            value={form.bundesland}
            onChange={(e) => setForm({ ...form, bundesland: e.target.value })}
          >
            {Object.entries(BUNDESLAND_LABELS).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}
