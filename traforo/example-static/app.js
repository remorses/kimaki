document.addEventListener('DOMContentLoaded', () => {
  const status = document.getElementById('status');
  
  // Show connection info
  status.textContent = `Connected via: ${window.location.host}`;
  status.classList.add('success');
});

async function testFetch() {
  const status = document.getElementById('status');
  status.textContent = 'Testing fetch...';
  status.className = 'status';
  
  try {
    const start = Date.now();
    const res = await fetch('/index.html');
    const elapsed = Date.now() - start;
    
    if (res.ok) {
      status.textContent = `Fetch OK! Status: ${res.status}, Time: ${elapsed}ms`;
      status.classList.add('success');
    } else {
      status.textContent = `Fetch failed: ${res.status}`;
      status.classList.add('error');
    }
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.classList.add('error');
  }
}
