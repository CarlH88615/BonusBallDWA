export interface BallState {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  num: number;
  isWinner?: boolean;
}

export interface NotificationMessage {
  id: string;
  title: string;
  body: string;
  timestamp: string;
  type: 'blast' | 'reminder' | 'win';
  target: string;
  read: boolean;
}

export type Tab = 'home' | 'balls' | 'winners' | 'admin';

export type AuthMode = 'login' | 'register' | 'forgot' | 'reset';
