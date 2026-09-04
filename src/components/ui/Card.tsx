import React from 'react';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function Card({ children, className, ...rest }: CardProps) {
  return (
    <div className={`card${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  action,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="card__header">
      <h3>{title}</h3>
      {action}
    </div>
  );
}

export function CardBody({ children, className }: CardProps) {
  return <div className={`card__body${className ? ` ${className}` : ''}`}>{children}</div>;
}
