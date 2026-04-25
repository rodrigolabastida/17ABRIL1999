let globalArticles = []; // Para acceder a ellos rápido al hacer click
let currentGeoPolled = false;
let searchDebounceTimeout = null;

document.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 Intlax v12.5 ACTIVO - Drag Maestro');
    
    // El Router toma el control total si estamos en una noticia
    const isArticle = await handleRouting();
    if (isArticle) {
        console.log('⏹️ Modo Artículo: Deteniendo carga de feed principal.');
        checkUserSession(); // Solo cargamos sesión para comentarios
        return; 
    }

    // Si no es artículo, flujo normal de portada
    checkLocationPermission();
    setupBottomNav();
    checkUserSession();
    setupDragScroll(); // <--- Nueva función de arrastre
});

function setupDragScroll() {
    const slider = document.getElementById('hero-container');
    if(!slider) return;

    let isDown = false;
    let startX;
    let scrollLeft;
    let moved = false;

    slider.style.cursor = 'grab';

    // Evitar que el navegador intente "arrastrar" las imágenes/links
    slider.querySelectorAll('img, a').forEach(el => {
        el.setAttribute('draggable', 'false');
    });

    slider.addEventListener('mousedown', (e) => {
        isDown = true;
        moved = false;
        slider.style.cursor = 'grabbing';
        slider.style.scrollBehavior = 'auto'; // Instantáneo pal arrastre
        slider.style.scrollSnapType = 'none'; 
        startX = e.pageX - slider.offsetLeft;
        scrollLeft = slider.scrollLeft;
    });

    slider.addEventListener('mouseleave', () => {
        isDown = false;
        slider.style.cursor = 'grab';
    });

    slider.addEventListener('mouseup', (e) => {
        isDown = false;
        slider.style.cursor = 'grab';
        slider.style.scrollSnapType = 'x mandatory';
        slider.style.scrollBehavior = 'smooth'; 
        
        // Si movimos más de 5px, bloqueamos el clic para que no entre a la noticia por error
        if (moved) {
            e.preventDefault();
        }
    });

    slider.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        const x = e.pageX - slider.offsetLeft;
        const walk = (x - startX) * 1.8; 
        if (Math.abs(walk) > 5) moved = true;
        slider.scrollLeft = scrollLeft - walk;
    });

    // Bloqueador de links si hubo arrastre
    slider.addEventListener('click', (e) => {
        if (moved) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);
}

// Router Inteligente para detectar si estamos en una noticia
async function handleRouting() {
    const path = window.location.pathname;
    if (path.startsWith('/noticias/')) {
        const slug = path.split('/').pop();
        if (slug) {
            console.log('🤖 Router: Detectada página de noticia para slug:', slug);
            await loadArticleBySlug(slug);
            return true;
        }
    }
    return false;
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
    // DESBLOQUEO TOTAL DE SCROLL (Fuerza Bruta v9.5)
    window.scrollTo(0, 0);
    document.body.style.overflow = 'visible';
    document.documentElement.style.overflow = 'visible';
    document.body.style.height = 'auto';
    document.documentElement.style.height = 'auto';
    
    // Ocultar elementos globales y limpiar modales residuales
    document.querySelectorAll('.top-bar, .top-nav, .bottom-nav, .modal-overlay, .full-modal').forEach(el => {
        el.style.display = 'none';
        el.classList.add('hidden');
    });

    const mainContainer = document.querySelector('main') || document.body;
    
    const pct = Math.round((noticia.puntuacion || 3) / 5 * 100);
    const barCol = (noticia.puntuacion || 3) >= 4 ? '#22C55E' : '#FFCC00';

    // Usamos posicionamiento relativo y forzamos altura automática
    mainContainer.innerHTML = `
        <div class="news-page-container" style="background:var(--bg-main); width:100%; min-height:100vh; height:auto; position:relative; z-index:9000; padding-bottom:100px; display:block;">
            <nav style="padding:15px; background:rgba(18,18,18,0.95); backdrop-filter:blur(15px); position:sticky; top:0; border-bottom:1px solid #333; display:flex; align-items:center; z-index:9001;">
                <a href="/" style="color:#fff; font-size:32px; text-decoration:none; display:flex; align-items:center;"><i class='bx bx-chevron-left'></i></a>
                <span style="font-weight:800; font-size:18px; margin-left:10px;">Noticia en Vivo</span>
            </nav>
            
            <img src="${noticia.imageUrl}" style="width:100%; height:320px; object-fit:cover; display:block;" onerror="this.src='/img/placeholder-noticia.jpg';">
            <div style="padding:25px; color:#fff;">
                <span style="color:var(--accent); font-weight:800; font-size:12px; text-transform:uppercase; letter-spacing:1.5px; margin-bottom:12px; display:block;">${noticia.source}</span>
                <h1 style="font-size:28px; font-weight:800; margin-bottom:18px; line-height:1.2; letter-spacing:-0.5px;">${noticia.title}</h1>
                <p style="color:var(--text-sec); font-size:17px; margin-bottom:30px; line-height:1.7;">${noticia.summary}</p>
                
                <a href="${noticia.link}" class="btn-primary" style="display:block; text-align:center; text-decoration:none; margin-bottom:15px; padding:18px; font-size:17px; border-radius:15px; box-shadow:0 10px 30px rgba(255,204,0,0.2); color:#000;">VER NOTA COMPLETA</a>
                
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:40px;">
                    <button onclick="shareArticle('${noticia.title.replace(/'/g, "\\'")}', '${noticia.link}')" class="btn-secondary" style="display:flex; align-items:center; justify-content:center; gap:8px; padding:15px; border-radius:12px; font-size:15px; font-weight:700;">
                        <i class='bx bx-share-alt'></i> Compartir
                    </button>
                    <button id="save-btn-${noticia.id}" onclick="toggleFavorite('${noticia.id}')" class="btn-secondary" style="display:flex; align-items:center; justify-content:center; gap:8px; padding:15px; border-radius:12px; font-size:15px; font-weight:700;">
                        <i class='bx bx-bookmark'></i> Guardar
                    </button>
                </div>

                <div class="card" style="margin-bottom:25px; padding:25px; background:#1C1C1E; border-radius:20px; border:1px solid #333;">
                    <h3 style="font-size:19px; font-weight:800; margin-bottom:18px; display:flex; align-items:center; gap:10px;"><i class='bx bxs-check-shield' style="color:var(--accent); font-size:24px;"></i> Confiabilidad Ciudadana</h3>
                    <div class="battery-container">
                        <div class="battery-bar" id="battery-rating" data-value="${Math.round(noticia.puntuacion || 3)}">
                            <div class="battery-segment" onclick="votarApp('${noticia.id}', 1)"></div>
                            <div class="battery-segment" onclick="votarApp('${noticia.id}', 2)"></div>
                            <div class="battery-segment" onclick="votarApp('${noticia.id}', 3)"></div>
                            <div class="battery-segment" onclick="votarApp('${noticia.id}', 4)"></div>
                            <div class="battery-segment" onclick="votarApp('${noticia.id}', 5)"></div>
                        </div>
                        <div class="battery-label">
                            <span>Poca Confianza</span>
                            <span>Alta Confianza</span>
                        </div>
                        <span class="battery-value-text" id="battery-status">${noticia.puntuacion || 3} de 5 Estrellas</span>
                    </div>
                </div>

                <div class="card" style="padding:25px; background:#1C1C1E; border-radius:20px; border:1px solid #333;">
                    <h3 style="font-size:19px; font-weight:800; margin-bottom:18px; display:flex; align-items:center; gap:10px;"><i class='bx bxs-group' style="color:var(--accent); font-size:24px;"></i> Comunidad</h3>
                    <div id="comments-router-box">
                        <p style="color:#666; font-size:14px; text-align:center; padding:20px;">Cargando comentarios...</p>
                    </div>
                </div>
            </div>
        </div>
    `;
    fetchCommentsForRouter(noticia.id);
}

async function votarApp(noticiaId, puntos) {
    try {
        const r = await fetch('/api/v1/valorar', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({noticia_id: noticiaId, puntos: puntos})
        });
        const data = await r.json();
        if(r.ok){
            document.getElementById('battery-rating').setAttribute('data-value', Math.round(data.promedio));
            document.getElementById('battery-status').innerText = `${parseFloat(data.promedio).toFixed(1)} de 5 Estrellas (${data.total} votos)`;
            alert('¡Gracias por votar!');
        } else {
            alert(data.error === 'Login necesario' ? 'Inicia sesión para votar' : data.error);
        }
    } catch (e) { console.error('Error al votar:', e); }
}

function shareArticle(title, url) {
    if (navigator.share) {
        navigator.share({
            title: title,
            url: url
        }).then(() => console.log('Compartido con éxito'))
          .catch((error) => console.log('Error compartiendo', error));
    } else {
        navigator.clipboard.writeText(url).then(() => {
            alert('Enlace copiado al portapapeles');
        });
    }
}

async function toggleFavorite(noticiaId) {
    try {
        const r = await fetch('/api/v1/favoritos', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({noticia_id: noticiaId})
        });
        const data = await r.json();
        if(r.ok) {
            const btn = document.getElementById(`save-btn-${noticiaId}`);
            if(data.saved) {
                btn.style.color = 'var(--accent)';
                btn.innerHTML = `<i class='bx bxs-bookmark'></i> Guardado`;
            } else {
                btn.style.color = '';
                btn.innerHTML = `<i class='bx bx-bookmark'></i> Guardar`;
            }
        } else {
            alert(data.error === 'Login necesario' ? 'Inicia sesión para guardar' : data.error);
        }
    } catch (e) { console.error('Error al guardar:', e); }
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
        
        // Tomamos la principal y las primeras 2 secundarias para el carrusel
        const heroArticles = [data.noticiaPrincipal, ...data.noticiasSecundarias.slice(0, 2)];
        const feedArticles = data.noticiasSecundarias.slice(2);

        renderHeroCarousel(heroArticles);
        renderFeed(feedArticles);
        attachClickBindings();

        // Ocultar preloader con clase suave
        const preloader = document.getElementById('preloader');
        if(preloader) preloader.classList.add('preloader-hidden');
    } catch (err) {
        console.error('Error cargando noticias:', err);
    }
}

function renderHeroCarousel(noticias) {
    const heroContainer = document.getElementById('hero-container');
    if(!noticias || noticias.length === 0 || !noticias[0]) {
        console.warn('⚠️ No hay noticias para el carrusel, intentando recarga...');
        heroContainer.innerHTML = '<div style="padding:20px; color:#666;">Cargando carrusel...</div>';
        return;
    }
    
    // Filtramos posibles noticias nulas
    const validas = noticias.filter(n => n && n.title);
    
    let carouselHTML = '';
    validas.forEach(noticia => {
        carouselHTML += `
            <a href="/noticias/${noticia.slug}" class="hero-card-link" style="text-decoration:none; color:inherit;">
                <div class="hero-card" data-id="${noticia.id}">
                    <div class="hero-img-wrapper" style="background:#1a1a1c;">
                        <img src="${noticia.imageUrl}" alt="${noticia.title}" style="width:100%; height:100%; object-fit:cover;" onerror="this.onerror=null; this.src='/img/placeholder-noticia.jpg';">
                        <div class="hero-gradient" style="position:absolute; inset:0; background:linear-gradient(to top, rgba(0,0,0,0.9) 0%, transparent 70%); padding:15px; display:flex; flex-direction:column; justify-content:flex-end;">
                            <div class="hero-meta" style="margin-bottom:8px;">
                                <span class="tag" style="color:var(--accent); font-weight:800; font-size:11px;">${noticia.source}</span>
                            </div>
                            <h2 class="hero-title" style="font-size:18px; font-weight:800; color:#fff; line-height:1.2;">${noticia.title}</h2>
                        </div>
                    </div>
                </div>
            </a>
        `;
    });
    
    heroContainer.innerHTML = carouselHTML;
}

function renderFeed(noticias) {
    const feedContainer = document.getElementById('feed-container');
    let feedHTML = '';
    
    noticias.forEach((noticia, index) => {
        // Alternamos algunas tarjetas para dar dinamismo (opcional, por ahora mantenemos consistencia premium)
        feedHTML += `
            <a href="/noticias/${noticia.slug}" class="news-card-link" style="text-decoration:none; color:inherit;">
                <article class="news-card" data-id="${noticia.id}" style="animation-delay: ${index * 0.05}s">
                    <img class="news-thumb" src="${noticia.imageUrl}" alt="${noticia.source}" onerror="this.onerror=null; this.src='/img/placeholder-noticia.jpg';">
                    <div class="news-info">
                        <div class="news-meta">
                             <span style="color:var(--accent); font-weight:700;">${noticia.source}</span>
                        </div>
                        <h3 class="news-title">${noticia.title}</h3>
                        <div class="news-bottom">
                            <div class="news-meta">
                                <span>${(noticia.views/1000).toFixed(1)}K lecturas</span>
                            </div>
                            <div class="news-actions">
                                <i class='bx bx-share-alt' onclick="event.preventDefault(); shareArticle('${noticia.title.replace(/'/g, "\\'")}', '${noticia.link}')"></i>
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
    const profileBtn = document.getElementById('nav-profile');
    const forosBtn = document.getElementById('nav-foros');
    const denunciasBtn = document.getElementById('nav-denuncias');

    const feedView = document.getElementById('feed-view');
    const searchView = document.getElementById('search-view');
    const profileView = document.getElementById('profile-view');

    function showView(viewId) {
        // Ocultar todas
        feedView.classList.add('hidden');
        searchView.classList.add('hidden');
        profileView.classList.add('hidden');
        
        // Quitar activos de botones
        [homeBtn, searchBtn, profileBtn, forosBtn, denunciasBtn].forEach(btn => btn?.classList.remove('active'));

        // Mostrar seleccionada
        if (viewId === 'home') {
            feedView.classList.remove('hidden');
            homeBtn.classList.add('active');
        } else if (viewId === 'search') {
            searchView.classList.remove('hidden');
            searchBtn.classList.add('active');
        } else if (viewId === 'profile') {
            profileView.classList.remove('hidden');
            profileBtn.classList.add('active');
            renderProfileView();
        }
    }

    homeBtn.addEventListener('click', () => showView('home'));
    searchBtn.addEventListener('click', () => showView('search'));
    profileBtn.addEventListener('click', () => showView('profile'));

    const inputBusqueda = document.getElementById('input-busqueda');
    inputBusqueda.addEventListener('input', (e) => {
        const term = e.target.value;
        if (searchDebounceTimeout) clearTimeout(searchDebounceTimeout);
        searchDebounceTimeout = setTimeout(() => {
            executeSearch(term);
        }, 300);
    });
}

async function renderProfileView() {
    const container = document.getElementById('profile-content');
    container.innerHTML = `<div style="text-align:center; padding:50px;"><p>Cargando perfil...</p></div>`;

    try {
        const response = await fetch('/api/v1/user-status');
        const user = await response.json();

        if (user && user.id) {
            // Cargar favoritos
            const favRes = await fetch('/api/v1/favoritos');
            const favoritos = await favRes.json();

            container.innerHTML = `
                <div class="profile-card">
                    <img src="${user.foto_perfil}" style="width:100px; height:100px; border-radius:50%; border:4px solid var(--accent); margin-bottom:20px;">
                    <h2 style="font-size:24px; font-weight:800; margin-bottom:5px;">${user.nombre}</h2>
                    <p style="color:var(--text-sec); margin-bottom:25px;">${user.email}</p>
                    
                    <div class="profile-stats">
                        <div class="stat-box">
                            <span class="stat-value">${user.puntos_reputacion || 0}</span>
                            <span class="stat-label">Puntos</span>
                        </div>
                        <div class="stat-box">
                            <span class="stat-value">${favoritos.length}</span>
                            <span class="stat-label">Guardadas</span>
                        </div>
                    </div>

                    <div style="margin-top:20px; text-align:left;">
                        <h3 style="font-size:18px; margin-bottom:15px; display:flex; align-items:center; gap:8px;"><i class='bx bxs-bookmark' style="color:var(--accent)"></i> Mis Guardados</h3>
                        <div id="saved-news-list" style="display:flex; flex-direction:column; gap:12px;">
                            ${favoritos.length ? favoritos.map(f => `
                                <a href="/noticias/${f.slug}" style="text-decoration:none; color:inherit;">
                                    <div style="background:rgba(255,255,255,0.03); padding:10px; border-radius:12px; display:flex; gap:10px; align-items:center;">
                                        <img src="${f.imageUrl}" style="width:50px; height:50px; border-radius:8px; object-fit:cover;">
                                        <div style="flex:1;">
                                            <p style="font-size:13px; font-weight:700; line-height:1.2; display:-webkit-box; -webkit-line-clamp:2; overflow:hidden; -webkit-box-orient:vertical;">${f.title}</p>
                                        </div>
                                    </div>
                                </a>
                            `).join('') : '<p style="color:#666; font-size:14px; text-align:center;">No tienes noticias guardadas.</p>'}
                        </div>
                    </div>

                    <a href="/auth/logout" class="btn-secondary" style="display:block; text-decoration:none; padding:15px; border-radius:12px; font-weight:700; margin-top:30px;">Cerrar Sesión</a>
                </div>
            `;
        } else {
            container.innerHTML = `
                <div class="login-prompt">
                    <i class='bx bxs-user-circle' style="font-size:80px; color:#333; margin-bottom:20px;"></i>
                    <h2 style="font-size:22px; font-weight:800; margin-bottom:10px;">Únete a Intlax</h2>
                    <p style="color:var(--text-sec); margin-bottom:30px; font-size:15px;">Inicia sesión para comentar, valorar noticias y ganar reputación en la comunidad.</p>
                    <a href="/auth/google" class="btn-primary" style="display:block; text-decoration:none; padding:18px; border-radius:15px; font-weight:800; font-size:16px;">Iniciar sesión con Google</a>
                </div>
            `;
        }
    } catch (e) {
        container.innerHTML = `<div style="text-align:center; padding:50px;"><p>Error al cargar el perfil. Intenta de nuevo.</p></div>`;
    }
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
