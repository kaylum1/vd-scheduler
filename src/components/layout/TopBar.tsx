import React from 'react';
import { IconMenu } from '../ui/icons';
import { RoleSwitcher } from './RoleSwitcher';

export function TopBar({ onMenuClick }: { onMenuClick: () => void }) {
  return (
    <header className="topbar">
      <div className="topbar__left">
        <div className="topbar__brand">
          <span className="topbar__brand-mark">VD</span>
          <span className="topbar__brand-text">
            <strong>VD Scheduler</strong>
            <span>Payroll</span>
          </span>
        </div>
        <button className="topbar__menu-btn" onClick={onMenuClick} aria-label="Toggle navigation">
          <IconMenu />
        </button>
      </div>
      <div className="topbar__right">
        <RoleSwitcher />
      </div>
    </header>
  );
}
