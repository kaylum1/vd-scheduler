import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader } from './Card';
import { getRepositories } from '../../repositories';
import type { ResortRecord } from '../../repositories/domain';

/**
 * Shared "Choose resort" state, extracted from three independently
 * duplicated copies (Resort & Shift Setup, Payroll Rules, Manager
 * Availability -- pre-Manual-Rota cleanup). Fetches all resorts, narrows to
 * active ones (Stage 2D Checkpoint 4.1 §5: normal operational selectors
 * show active resorts only), and keeps `selectedResortId` valid as resorts
 * load, change, or the current selection is deactivated -- defaulting to
 * the first active resort, never leaving a stale/invalid id selected.
 *
 * Returns the raw setter rather than an onSelect callback: a caller that
 * needs a side effect alongside selection (Manager Availability collapses
 * its expanded driver row) wraps `setSelectedResortId` itself when calling
 * <ResortSelector onSelect={...}> -- this hook never assumes one.
 */
export function useActiveResortSelection() {
  const [selectedResortId, setSelectedResortId] = useState<string | null>(null);

  const resortsQuery = useQuery({
    queryKey: ['config', 'resorts'],
    queryFn: () => getRepositories().resorts.listResorts(),
  });

  const activeResorts = useMemo(() => (resortsQuery.data ?? []).filter((r) => r.isActive), [resortsQuery.data]);

  useEffect(() => {
    if (!resortsQuery.data) return;
    const stillValidSelection = selectedResortId !== null && activeResorts.some((r) => r.id === selectedResortId);
    if (!stillValidSelection) {
      setSelectedResortId(activeResorts[0]?.id ?? null);
    }
  }, [resortsQuery.data, activeResorts, selectedResortId]);

  const selectedResort = useMemo(() => activeResorts.find((r) => r.id === selectedResortId) ?? null, [activeResorts, selectedResortId]);

  return { resortsQuery, activeResorts, selectedResortId, setSelectedResortId, selectedResort };
}

/**
 * Pure presentational "Choose resort" segmented control -- the pattern
 * established in Resort & Shift Setup (Stage 2D Checkpoint 4.1's UX
 * amendment), now shared rather than re-implemented per page. Renders
 * nothing when `resorts` is empty; each caller keeps its own empty state
 * underneath. No routing/business logic here -- `onSelect` is entirely the
 * caller's.
 */
export function ResortSelector({
  resorts,
  selectedResortId,
  onSelect,
}: {
  resorts: ResortRecord[];
  selectedResortId: string | null;
  onSelect: (resortId: string) => void;
}) {
  if (resorts.length === 0) return null;

  return (
    <Card style={{ marginBottom: 16 }}>
      <CardHeader title="Choose resort" />
      <div className="resort-chooser segmented" role="tablist" aria-label="Choose resort">
        {resorts.map((resort) => (
          <button
            key={resort.id}
            role="tab"
            aria-selected={resort.id === selectedResortId}
            className={`segmented__item${resort.id === selectedResortId ? ' is-active' : ''}`}
            onClick={() => onSelect(resort.id)}
          >
            {resort.name}
          </button>
        ))}
      </div>
    </Card>
  );
}
