import React, { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import { RouterProvider, useRouter } from './router';
import { AppStateProvider, useAppState } from './state/AppStateContext';
import { DashboardPage } from './pages/manager/Dashboard';
import { RotaAvailabilityPage } from './pages/manager/RotaAvailability';
import { PayrollPage } from './pages/manager/Payroll';
import { ConfigurationPage } from './pages/manager/Configuration';
import { MyRotaPage } from './pages/driver/MyRota';
import { AvailabilityPage } from './pages/driver/Availability';

const managerDefaultPath = '/manager/dashboard';
const driverDefaultPath = '/driver/my-rota';

function RouteOutlet() {
  const { path, navigate } = useRouter();
  const { role, isLoggedOut } = useAppState();

  useEffect(() => {
    if (isLoggedOut) return;
    const isManagerPath = path.startsWith('/manager');
    const isDriverPath = path.startsWith('/driver');

    if (path === '/' || (!isManagerPath && !isDriverPath)) {
      navigate(role === 'manager' ? managerDefaultPath : driverDefaultPath);
      return;
    }
    // Guard against viewing the other role's routes directly via URL.
    if (role === 'manager' && isDriverPath) {
      navigate(managerDefaultPath);
    } else if (role === 'driver' && isManagerPath) {
      navigate(driverDefaultPath);
    }
  }, [path, role, isLoggedOut]);

  switch (path) {
    case '/manager/dashboard':
      return <DashboardPage />;
    case '/manager/rota':
      return <RotaAvailabilityPage />;
    case '/manager/payroll':
      return <PayrollPage />;
    case '/manager/configuration':
      return <ConfigurationPage />;
    case '/driver/my-rota':
      return <MyRotaPage />;
    case '/driver/availability':
      return <AvailabilityPage />;
    default:
      return null;
  }
}

function Shell() {
  return (
    <AppShell>
      <RouteOutlet />
    </AppShell>
  );
}

export default function App() {
  return (
    <AppStateProvider>
      <RouterProvider>
        <Shell />
      </RouterProvider>
    </AppStateProvider>
  );
}
