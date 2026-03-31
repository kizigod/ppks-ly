async function loadDashboard() {
    try {
        const response = await fetch('/api/user/links');
        
        // Jika user belum login, lempar balik ke halaman login
        if (response.status === 401) {
            window.location.href = '/';
            return;
        }

        const links = await response.json();
        renderTable(links);
    } catch (err) {
        console.error("Gagal memuat dashboard:", err);
    }
}

function renderTable(links) {
    const tbody = document.getElementById('links-tbody');
    const totalLinks = document.getElementById('total-links');
    const totalClicks = document.getElementById('total-clicks');
    
    let clicksSum = 0;
    tbody.innerHTML = ''; // Reset tabel

    links.forEach(link => {
        clicksSum += link.clicks;
        const row = `
            <tr>
                <td><strong>${link.shortCode}</strong></td>
                <td class="truncate">${link.originalUrl}</td>
                <td><span class="badge">${link.clicks}</span></td>
                <td>
                    <button onclick="deleteLink('${link._id}')" class="btn-delete">Hapus</button>
                </td>
            </tr>
        `;
        tbody.innerHTML += row;
    });

    totalLinks.innerText = links.length;
    totalClicks.innerText = clicksSum;
}

async function deleteLink(id) {
    if (confirm('Yakin ingin menghapus link ini?')) {
        await fetch(`/api/link/${id}`, { method: 'DELETE' });
        loadDashboard(); // Refresh data
    }
}

// Jalankan saat halaman dibuka
loadDashboard();