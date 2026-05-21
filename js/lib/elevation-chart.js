const THEME = {
  line: '#2d5016',
  fill: 'rgba(45, 80, 22, 0.18)',
  axis: '#555',
  grid: 'rgba(0,0,0,0.06)',
};

function toDataset(elevationData) {
  const data = (elevationData || []).map((p) => ({
    x: Math.round(p.km * 100) / 100,
    y: Math.round(p.ele),
  }));
  return {
    label: 'Altitudine (m)',
    data,
    borderColor: THEME.line,
    backgroundColor: THEME.fill,
    borderWidth: 2,
    pointRadius: 0,
    fill: true,
    tension: 0.25,
  };
}

export function create(canvasEl, elevationData) {
  if (!canvasEl || typeof Chart === 'undefined') return null;
  return new Chart(canvasEl, {
    type: 'line',
    data: { datasets: [toDataset(elevationData)] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            title: (items) => `${items[0].parsed.x.toFixed(1)} km`,
            label: (item) => `${Math.round(item.parsed.y)} m`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Distanza (km)', color: THEME.axis },
          ticks: { color: THEME.axis },
          grid: { color: THEME.grid },
        },
        y: {
          title: { display: true, text: 'Altitudine (m)', color: THEME.axis },
          ticks: { color: THEME.axis },
          grid: { color: THEME.grid },
        },
      },
    },
  });
}

export function update(chartInstance, elevationData) {
  if (!chartInstance) return;
  chartInstance.data.datasets = [toDataset(elevationData)];
  chartInstance.update();
}
