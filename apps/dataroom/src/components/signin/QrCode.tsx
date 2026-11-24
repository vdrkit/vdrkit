// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

export function QrCode({ value }: { value: string }) {
  const { n, d } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const size = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (qr.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
      }
    }
    return { n: size, d: path };
  }, [value]);
  return (
    <svg className="qr" viewBox={`-1 -1 ${n + 2} ${n + 2}`} role="img" aria-label="QR code to scan with your authenticator app" shapeRendering="crispEdges">
      <rect x="-1" y="-1" width={n + 2} height={n + 2} fill="#FFFFFF" />
      <path d={d} fill="#0F1A24" />
    </svg>
  );
}
