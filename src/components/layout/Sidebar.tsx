import React from 'react';
import { Link, useRouter } from '../../router';
import { useAppState } from '../../state/AppStateContext';
import { useAuth } from '../../auth/AuthContext';
import { IconLogout } from '../ui/icons';
import { driverNavItems, managerNavItems } from './nav-config';

export function Sidebar({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { logout } = useAppState();
  // Role comes from useAuth() (the real app_users-backed role in Supabase
  // mode; the same value useAppState().role would give in mock mode) so
  // the nav never shows a real driver manager-only links, or vice versa.
  const { role } = useAuth();
  const { path } = useRouter();
  const items = role === 'manager' ? managerNavItems : driverNavItems;

  return (
    <>
      <aside className={`sidebar${isOpen ? ' is-open' : ''}`} aria-label="Primary navigation">
        <div className="sidebar__section-label">{role === 'manager' ? 'Manager' : 'Driver'}</div>
        <nav className="sidebar__nav">
          {items.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={`sidebar__link${path === item.path ? ' is-active' : ''}`}
              onClick={onClose}
            >
              <span className="sidebar__link-icon">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar__footer">
          <button
            className="sidebar__link"
            onClick={() => {
              logout();
              onClose();
            }}
          >
            <span className="sidebar__link-icon">
              <IconLogout />
            </span>
            Logout
          </button>
        </div>
      </aside>
      <div className={`sidebar__backdrop${isOpen ? ' is-open' : ''}`} onClick={onClose} />
    </>
  );
}
