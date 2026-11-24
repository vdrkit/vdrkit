// SPDX-License-Identifier: AGPL-3.0-only
const svg = (d: React.ReactNode) => <svg viewBox="0 0 24 24" aria-hidden="true">{d}</svg>;

export const MailIcon = () => svg(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 6.5L12 13l8.5-6.5" /></>);
export const LeaveIcon = () => svg(<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4l4-4M6 12h10" />);
export const ClockIcon = () => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const LockIcon = () => svg(<><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>);
export const NotFoundIcon = () => svg(<><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.4-4.4M8.5 11h5" /></>);
export const ClosedIcon = () => svg(<><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 9h16M10 13h4" /></>);
export const FaultIcon = () => svg(<><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17h.01" /></>);
export const UpdateIcon = () => svg(<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4" />);
