import type { ThemeConfig } from 'antd';

/** Clinical, low-noise palette: deep navy chrome, teal accent. */
export const theme: ThemeConfig = {
  token: {
    colorPrimary: '#0e7c86',
    colorInfo: '#0e7c86',
    colorLink: '#0e7c86',
    borderRadius: 6,
    fontFamily:
      "'Inter', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
  },
  components: {
    Layout: {
      siderBg: '#0b2333',
      headerBg: '#ffffff',
      bodyBg: '#f3f6f8',
    },
    Menu: {
      darkItemBg: '#0b2333',
      darkItemSelectedBg: '#0e7c86',
    },
  },
};
