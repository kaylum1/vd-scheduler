import React, { useEffect, useState } from 'react';
import { useRouter } from '../../router';
import { useAppState } from '../../state/AppStateContext';
import { LoggedOutScreen } from './LoggedOutScreen';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export function AppShell({ children }: { children: React.ReactNode }) {
  const { isLoggedOut } = useAppState();
  const { path } = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    setDrawerOpen(false);
  }, [path]);

  if (isLoggedOut) {
    return <LoggedOutScreen />;
  }

  return (
    <div className="app-shell">
      <TopBar onMenuClick={() => setDrawerOpen((v) => !v)} />
      <Sidebar isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <div className="app-main">{children}</div>
    </div>
  );
}
