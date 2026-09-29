import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('#root is missing from index.html');
}

// Deliberately not wrapped in StrictMode. Its development-only double-mount
// would create two GPU devices and reconfigure one canvas twice per reload,
// which shows up as a blank first frame and a device-lost message -- a bug that
// exists only in development and is impossible to reason about from the code.
createRoot(root).render(<App />);
