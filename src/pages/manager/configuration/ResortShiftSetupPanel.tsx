import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Badge } from '../../../components/ui/Badge';
import { StatusPill } from '../../../components/ui/StatusPill';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Button } from '../../../components/ui/Button';
import { getRepositories } from '../../../repositories';
import { describeConfigurationError } from './errorMessages';
import { ShiftSetupPanel } from './ShiftSetupPanel';

export function ResortShiftSetupPanel() {
  const [selectedResortId, setSelectedResortId] = useState<string | null>(null);

  const resortsQuery = useQuery({
    queryKey: ['config', 'resorts'],
    queryFn: () => getRepositories().resorts.listResorts(),
  });

  // Default to the first resort once resorts load, without fighting a
  // manager's own later selection.
  useEffect(() => {
    if (!selectedResortId && resortsQuery.data && resortsQuery.data.length > 0) {
      setSelectedResortId(resortsQuery.data[0].id);
    }
  }, [resortsQuery.data, selectedResortId]);

  const selectedResort = useMemo(
    () => resortsQuery.data?.find((r) => r.id === selectedResortId) ?? null,
    [resortsQuery.data, selectedResortId]
  );

  return (
    <>
      <Card style={{ marginBottom: 16 }}>
        <CardHeader title="Resorts" />
        {resortsQuery.isLoading ? (
          <div className="config-loading">Loading resorts…</div>
        ) : resortsQuery.isError ? (
          <div className="config-error">
            <p>Couldn't load resorts. {describeConfigurationError(resortsQuery.error, 'driver')}</p>
            <Button variant="secondary" size="sm" onClick={() => resortsQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : !resortsQuery.data?.length ? (
          <EmptyState title="No resorts configured yet" />
        ) : (
          <div style={{ padding: 18 }}>
            <div className="segmented" role="tablist" aria-label="Select resort to configure">
              {resortsQuery.data.map((r) => (
                <button
                  key={r.id}
                  role="tab"
                  aria-selected={r.id === selectedResortId}
                  className={`segmented__item${r.id === selectedResortId ? ' is-active' : ''}`}
                  onClick={() => setSelectedResortId(r.id)}
                >
                  <span className={`resort-dot resort-dot--${r.slug}`} />
                  {r.name}
                </button>
              ))}
            </div>
            {selectedResort && (
              <div className="config-resort-info">
                <span>
                  Now configuring <strong>{selectedResort.name}</strong>
                </span>
                <Badge tone="blue">{selectedResort.timezone}</Badge>
                <StatusPill tone={selectedResort.isActive ? 'green' : 'grey'}>
                  {selectedResort.isActive ? 'Active' : 'Inactive'}
                </StatusPill>
              </div>
            )}
          </div>
        )}
      </Card>

      {selectedResort && <ShiftSetupPanel resortId={selectedResort.id} resortName={selectedResort.name} />}
    </>
  );
}
