let globalArticles = []; // Para acceder a ellos rápido al hacer click
let currentGeoPolled = false;
let searchDebounceTimeout = null;

document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Intlax v7.0 Activo - Modo Router Híbrido');
    checkLocationPermission();
    setupBottomNav();
    checkUserSession();
    handleRouting(); // Nueva función de routing
});

// Router Inteligente para detectar si estamos en una noticia
async function handleRouting() {
    const path = window.location.pathname;
    if (path.startsWith('/noticias/')) {
        const slug = path.split('/').pop();
        if (slug) {
            console.log('🤖 Router: Detectada página de noticia para slug:', slug);
            loadArticleBySlug(slug);
        }
    }
}

async function loadArticleBySlug(slug) {
    try {
        const res = await fetch('/api/v1/feed');
        const data = await res.json();
        const allArticles = [data.noticiaPrincipal, ...data.noticiasSecundarias];
        const article = allArticles.find(a => a.slug === slug);
        
        if (article) {
            console.log('✅ Noticia encontrada por el router, inyectando vista...');
            renderArticleDetail(article);
        } else {
            console.error('❌ Noticia no encontrada en el feed actual');
        }
    } catch (e) { console.error('Error en routing:', e); }
}

function renderArticleDetail(noticia) {
    document.body.style.overflow = 'auto';
    const mainContainer = document.querySelector('main') || document.body;
    
    const pct = Math.round((noticia.puntuacion || 3) / 5 * 100);
    const barCol = (noticia.puntuacion || 3) >= 4 ? '#22C55E' : '#FFCC00';

    mainContainer.innerHTML = `
        <div class="news-page-container" style="background:var(--bg); min-height:100vh; position:fixed; top:0; left:0; width:100%; z-index:9999; overflow-y:auto; padding-bottom:100px;">
            <nav style="padding:15px; background:rgba(18,18,18,0.9); backdrop-filter:blur(10px); position:sticky; top:0; border-bottom:1px solid #333; display:flex; align-items:center; gap:15px;">
                <a href="/" style="color:#fff; font-size:28px; text-decoration:none;"><i class='bx bx-chevron-left'></i></a>
                <span style="font-weight:800;">Noticia</span>
            </nav>
            <img src="${noticia.imageUrl}" style="width:100%; height:280px; object-fit:cover;" onerror="this.src='/img/placeholder-noticia.jpg'">
            <div style="padding:20px;">
                <span style="color:var(--accent); font-weight:800; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px; display:block;">${noticia.source}</span>
                <h1 style="font-size:24px; font-weight:800; margin-bottom:15px; line-height:1.25;">${noticia.title}</h1>
                <p style="color:var(--text-sec); font-size:16px; margin-bottom:25px;">${noticia.summary}</p>
                <a href="${noticia.link}" class="btn-primary" style="display:block; text-align:center; text-decoration:none; margin-bottom:30px;">VER NOTA COMPLETA</a>

                <div class="card" style="margin-bottom:20px;">
                    <h3 style="font-size:18px; font-weight:800; margin-bottom:15px;"><i class='bx bxs-check-shield' style="color:var(--accent)"></i> Confiabilidad</h3>
                    <div style="height:12px; background:#333; border-radius:6px; overflow:hidden; margin-bottom:10px;">
                        <div style="width:${pct}%; height:100%; background:${barCol};"></div>
                    </div>
                    <p style="font-size:13px; color:var(--text-sec);">${noticia.puntuacion || 3} de 5 Estrellas comunitarias</p>
                </div>

                <div class="card">
                    <h3 style="font-size:18px; font-weight:800; margin-bottom:15px;"><i class='bx bxs-group' style="color:var(--accent)"></i> Comunidad</h3>
                    <div id="comments-router-box">
                        <p style="color:#666; font-size:14px; text-align:center; padding:10px;">Cargando comentarios...</p>
                    </div>
                </div>
            </div>
        </div>
    `;
    fetchCommentsForRouter(noticia.id);
}

async function fetchCommentsForRouter(noticiaId) {
    try {
        const res = await fetch('/api/v1/comentarios?noticia_id=' + noticiaId);
        const comments = await res.json();
        const box = document.getElementById('comments-router-box');
        if (box && comments && comments.length) {
            let html = '';
            comments.forEach(c => {
                html += `
                    <div style="background:#252527; padding:12px; border-radius:12px; margin-bottom:12px; border-left:3px solid var(--accent);">
                        <div style="display:flex; align-items:center; gap:8px; font-weight:700; font-size:13px; margin-bottom:4px;">
                            <img src="${c.foto_perfil}" style="width:22px; height:22px; border-radius:50%;">
                            <span>${c.usuario_nombre}</span>
                        </div>
                        <p style="font-size:14px; color:#ddd; margin:0;">${c.comentario}</p>
                    </div>
                `;
            });
            box.innerHTML = html;
        } else if(box) {
            box.innerHTML = '<p style="color:#666; font-size:14px; text-align:center; padding:10px;">¡Sé el primero en comentar!</p>';
        }
    } catch (e) { console.error('Error cargando comentarios routing:', e); }
}

async function checkUserSession() {
    try {
        const response = await fetch('/api/v1/user-status');
        const user = await response.json();
        const container = document.getElementById('user-auth-container');
        if (user && user.id) {
            container.innerHTML = `<img src="${user.foto_perfil}" style="width:32px;height:32px;border-radius:50%;border:2px solid var(--accent)" onclick="location.href='/auth/logout'">`;
        } else {
            container.innerHTML = `<i class='bx bxs-user-circle' style="font-size: 32px; color: var(--text-sec);" onclick="location.href='/auth/google'"></i>`;
        }
    } catch (e) {}
}

function checkLocationPermission() {
    const locPref = localStorage.getItem('intlax_loc_pref');
    if (locPref === 'granted') {
        getLocationAndFetch();
    } else if (locPref === 'denied') {
        fetchNews(); 
    } else {
        document.getElementById('location-modal-overlay').classList.remove('hidden');
    }
}

document.getElementById('btn-allow-loc').addEventListener('click', () => {
    document.getElementById('location-modal-overlay').classList.add('hidden');
    localStorage.setItem('intlax_loc_pref', 'granted');
    getLocationAndFetch();
});

document.getElementById('btn-deny-loc').addEventListener('click', () => {
    document.getElementById('location-modal-overlay').classList.add('hidden');
    localStorage.setItem('intlax_loc_pref', 'denied');
    fetchNews(); 
});

function getLocationAndFetch() {
    if (navigator.geolocation && !currentGeoPolled) {
        currentGeoPolled = true; 
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                fetchNews('?lat=' + lat + '&lng=' + lng);
            },
            () => fetchNews()
        );
    } else {
        fetchNews();
    }
}

async function fetchNews(params = '') {
    try {
        const response = await fetch('/api/v1/feed' + params);
        if (!response.ok) throw new Error('Error en el servidor');
        const data = await response.json();
        
        globalArticles = [data.noticiaPrincipal, ...data.noticiasSecundarias];
        renderHero(data.noticiaPrincipal);
        renderFeed(data.noticiasSecundarias);
        attachClickBindings();
    } catch (err) {
        console.error('Error cargando noticias:', err);
    }
}

function renderHero(noticia) {
    if(!noticia) return;
    const heroContainer = document.getElementById('hero-container');
    // Envolvemos en un link para que sea nativo y más robusto
    heroContainer.innerHTML = `
        <a href="/noticias/${noticia.slug}" class="hero-card-link" style="text-decoration:none; color:inherit;">
            <div class="hero-card" data-id="${noticia.id}">
                <img class="hero-img" src="${noticia.imageUrl}" alt="${noticia.title}" onerror="this.onerror=null; this.src='/img/placeholder-noticia.jpg';">
                <div class="hero-overlay">
                    <span class="category-badge">${noticia.source}</span>
                    <h2 class="hero-title">${noticia.title}</h2>
                </div>
            </div>
        </a>
    `;
}

function renderFeed(noticias) {
    const feedContainer = document.getElementById('feed-container');
    let feedHTML = '';
    
    noticias.forEach(noticia => {
        feedHTML += `
            <a href="/noticias/${noticia.slug}" class="news-card-link" style="text-decoration:none; color:inherit;">
                <article class="news-card" data-id="${noticia.id}">
                    <img class="news-thumb" src="${noticia.imageUrl}" alt="${noticia.source}" onerror="this.onerror=null; this.src='/img/placeholder-noticia.jpg';">
                    <div class="news-info">
                        <h3 class="news-title">${noticia.title}</h3>
                        <div class="news-bottom">
                            <div class="news-meta">
                                <span>${noticia.category}</span>
                                <span>• ${(noticia.views/1000).toFixed(1)}K vistas</span>
                            </div>
                            <div class="news-actions">
                                <i class='bx bx-message-rounded'></i>
                                <i class='bx bx-share-alt' ></i>
                            </div>
                        </div>
                    </div>
                </article>
            </a>
        `;
    });
    
    feedContainer.innerHTML = feedHTML;
}

function attachClickBindings() {
    // Ya no es estrictamente necesario por los links nativos, 
    // pero lo dejamos como respaldo para cualquier acción extra futura
    console.log('✅ Navegación nativa activada');
}

function setupBottomNav() {
    const homeBtn = document.getElementById('nav-home');
    const searchBtn = document.getElementById('nav-search');
    const feedView = document.getElementById('feed-view');
    const searchView = document.getElementById('search-view');

    homeBtn.addEventListener('click', () => {
        feedView.classList.remove('hidden');
        searchView.classList.add('hidden');
        homeBtn.classList.add('active');
        searchBtn.classList.remove('active');
    });

    searchBtn.addEventListener('click', () => {
        searchView.classList.remove('hidden');
        feedView.classList.add('hidden');
        searchBtn.classList.add('active');
        homeBtn.classList.remove('active');
    });

    const inputBusqueda = document.getElementById('input-busqueda');
    inputBusqueda.addEventListener('input', (e) => {
        const term = e.target.value;
        if (searchDebounceTimeout) clearTimeout(searchDebounceTimeout);
        searchDebounceTimeout = setTimeout(() => {
            executeSearch(term);
        }, 300);
    });
}

async function executeSearch(term) {
    if (term.length < 2) return;
    try {
        const res = await fetch('/api/v1/search?q=' + encodeURIComponent(term));
        const data = await res.json();
        renderSearchResults(data.resultados);
    } catch (e) {
        console.error('Error en búsqueda:', e);
    }
}

function renderSearchResults(resultados) {
    const resultadosContainer = document.getElementById('contenedor-resultados-busqueda');
    let feedHTML = '';
    
    if (resultados && resultados.length > 0) {
        resultados.forEach(noticia => {
            feedHTML += `
                <article class="news-card" data-id="${noticia.id}">
                    <img class="news-thumb" src="${noticia.imageUrl}" alt="${noticia.source}" onerror="this.onerror=null; this.src='/img/placeholder-noticia.jpg';">
                    <div class="news-info">
                        <h3 class="news-title">${noticia.title}</h3>
                        <div class="news-bottom">
                            <div class="news-meta">
                                <span>${noticia.category}</span>
                                <span>• ${(noticia.views/1000).toFixed(1)}K vistas</span>
                            </div>
                            <div class="news-actions">
                                <i class='bx bx-message-rounded'></i>
                                <i class='bx bx-share-alt' ></i>
                            </div>
                        </div>
                    </div>
                </article>
            `;
        });
        
        resultadosContainer.innerHTML = feedHTML;
        
        const searchCards = document.querySelectorAll('#contenedor-resultados-busqueda .news-card');
        searchCards.forEach(card => {
            card.addEventListener('click', () => {
                const id = card.getAttribute('data-id');
                // Para búsqueda, necesitamos que globalArticles tenga los resultados o buscarlos
                const article = resultados.find(a => a.id === id);
                if(article && article.slug) {
                    window.location.href = '/noticias/' + article.slug;
                }
            });
        });

    } else {
        resultadosContainer.innerHTML = `
            <div id="empty-state-search" class="empty-state">
                <i class='bx bx-search-alt-2'></i>
                <p>No se encontraron resultados para tu búsqueda.</p>
            </div>
        `;
    }
}

window.fillSearch = function(term) {
    const input = document.getElementById('input-busqueda');
    input.value = term;
    executeSearch(term);
};
