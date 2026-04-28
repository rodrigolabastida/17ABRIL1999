let globalArticles = []; // Para acceder a ellos rápido al hacer click
let currentGeoPolled = false;
let searchDebounceTimeout = null;

document.addEventListener('DOMContentLoaded', async () => {
    console.log('%c 🚀 Intlax v4.0 ACTIVO - Autonomous Intelligence Engine ', 'background: #FFCC00; color: #000; font-weight: bold; padding: 4px; border-radius: 4px;');
    localStorage.removeItem('intlax_loc_pref'); // Limpieza de rastro de versiones viejas
    
    // El Router toma el control total si estamos en una noticia
    const isArticle = await handleRouting();
    if (isArticle) {
        console.log('⏹️ Modo Artículo: Deteniendo carga de feed principal.');
        checkUserSession(); // Solo cargamos sesión para comentarios
        return; 
    }

    // Si no es artículo, flujo normal de portada
    fetchNews(); // Carga inmediata de noticias generales
    setupBottomNav();
    checkUserSession();
    setupDragScroll();
    setupGeoButton(); // Nueva función para el botón manual

    // Timeout de seguridad: Si en 4s no cargan las noticias, forzamos la entrada
    setTimeout(() => {
        const preloader = document.getElementById('preloader');
        if (preloader && !preloader.classList.contains('preloader-hidden')) {
            console.log('⏱️ Timeout del preloader alcanzado. Forzando entrada.');
            preloader.classList.add('preloader-hidden');
        }
    }, 4000); 
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
    // ELIMINACIÓN DE PRELOADER EN NOTICIAS (v21.0)
    // Lo ocultamos de inmediato para que la transición sea transparente
    if(window.hidePreloader) window.hidePreloader();

    try {
        const res = await fetch('/api/v1/feed');
        const data = await res.json();
        const allArticles = [data.noticiaPrincipal, ...data.noticiasSecundarias];
        let article = allArticles.find(a => a.slug === slug);
        
        if (!article) {
            const res2 = await fetch('/api/v1/noticias/' + slug);
            const data2 = await res2.json();
            if (data2 && data2.noticia) article = data2.noticia;
        }

        if (article) {
            renderArticleDetail(article);
        } else {
            console.error('❌ Noticia no encontrada.');
            window.location.href = '/';
        }
    } catch (e) { 
        console.error('Error en routing:', e);
    }
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
                
                <button onclick="openInAppBrowser('${noticia.link}')" class="btn-primary" style="width:100%; display:block; text-align:center; border:none; margin-bottom:15px; padding:18px; font-size:17px; border-radius:15px; box-shadow:0 10px 30px rgba(255,204,0,0.2); color:#000; font-weight:800; cursor:pointer;">VER NOTA COMPLETA</button>
                
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:40px;">
                    <button onclick="shareArticle('${(noticia.title || '').replace(/'/g, "\\\\'")}', window.location.origin + '/noticias/${noticia.slug}')" class="btn-secondary" style="display:flex; align-items:center; justify-content:center; gap:8px; padding:15px; border-radius:12px; font-size:15px; font-weight:700;">
                        <i class='bx bx-share-alt'></i> Compartir
                    </button>
                    <button id="save-btn-${noticia.id}" onclick="toggleFavorite('${noticia.id}')" class="btn-secondary" style="display:flex; align-items:center; justify-content:center; gap:8px; padding:15px; border-radius:12px; font-size:15px; font-weight:700;">
                        <i class='bx bx-bookmark'></i> Guardar
                    </button>
                </div>

                <div class="card" style="margin-bottom:25px; padding:25px; background:#1C1C1E; border-radius:20px; border:1px solid #333;">
                    <h3 style="font-size:19px; font-weight:800; margin-bottom:10px; display:flex; align-items:center; gap:10px;"><i class='bx bxs-check-shield' style="color:var(--accent); font-size:24px;"></i> Confiabilidad Ciudadana</h3>
                    <p style="font-size:13px; color:var(--text-sec); margin-bottom:15px;">Pulsa una barra para calificar la nota:</p>
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
                        <p style="color:#666; font-size:14px; text-align:center; padding:20px;">Cargando opiniones...</p>
                    </div>
                    <div style="margin-top:20px; border-top:1px solid #333; padding-top:20px;">
                        <textarea id="nc-router" style="width:100%; background:#121212; border:1px solid #444; border-radius:12px; color:#fff; padding:15px; font-family:inherit; box-sizing:border-box;" placeholder="¿Qué opinas sobre esto?" rows="3"></textarea>
                        <button onclick="postCommentApp('${noticia.id}')" style="width:100%; background:var(--accent); border:none; padding:15px; border-radius:12px; font-weight:800; margin-top:15px; cursor:pointer;">Publicar opinión</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    fetchCommentsForRouter(noticia.id);
    
    // LIBERACIÓN: Quitar preloader al finalizar el dibujo
    setTimeout(() => {
        if(window.hidePreloader) window.hidePreloader();
    }, 100);
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
            alert('¡Gracias por tu voto ciudadano!');
        } else {
            alert(data.error);
        }
    } catch (e) { console.error('Error al votar:', e); }
}
window.votarApp = votarApp;

async function postCommentApp(noticiaId) {
    const t = document.getElementById('nc-router').value;
    if(!t) return;
    try {
        const r = await fetch('/api/v1/comentar', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({noticia_id: noticiaId, comentario: t})
        });
        if(r.ok) {
            document.getElementById('nc-router').value = '';
            fetchCommentsForRouter(noticiaId);
        }
    } catch (e) { console.error('Error al comentar:', e); }
}
window.postCommentApp = postCommentApp;

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

// La lógica de ubicación automática ha sido eliminada en v2.1 para favorecer el Radar Premium bajo demanda.

function setupGeoButton() {
    const btn = document.getElementById('btn-geo-activate');
    if (btn) {
        btn.addEventListener('click', () => {
            btn.innerHTML = "<i class='bx bx-loader-alt bx-spin'></i> Obteniendo ubicación...";
            getLocationAndFetch();
        });
    }
}

function getLocationAndFetch() {
    const btn = document.getElementById('btn-geo-activate');
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                if (btn) {
                    btn.innerHTML = "<i class='bx bxs-map-pin' style='color:var(--accent);'></i> Noticias cercanas activas";
                    btn.style.background = "rgba(255,204,0,0.1)";
                    btn.style.borderColor = "var(--accent)";
                }
                fetchNews('?lat=' + lat + '&lng=' + lng);
            },
            () => {
                if (btn) btn.innerHTML = "<i class='bx bx-compass'></i> Ver noticias cerca de mí";
                fetchNews();
            }
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
        
        const noticiasRaw = data.noticiasSecundarias || [];
        const principal = data.noticiaPrincipal || noticiasRaw[0];
        const secundarias = data.noticiaPrincipal ? noticiasRaw : noticiasRaw.slice(1);
        
        globalArticles = principal ? [principal, ...secundarias] : secundarias;
        
        // Carrusel: Principal + 2 primeras disponibles
        const heroArticles = principal ? [principal, ...secundarias.slice(0, 2)] : secundarias.slice(0, 3);
        // Feed: El resto
        const feedArticles = principal ? secundarias.slice(2) : secundarias.slice(3);

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
                                <i class='bx bx-share-alt' onclick="event.preventDefault(); shareArticle('${(noticia.title || '').replace(/'/g, "\\\\'")}', window.location.origin + '/noticias/${noticia.slug}')"></i>
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
        document.getElementById('foros-view').classList.add('hidden');
        document.getElementById('denuncias-view').classList.add('hidden');
        
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
        } else if (viewId === 'foros') {
            document.getElementById('foros-view').classList.remove('hidden');
            forosBtn.classList.add('active');
            renderForosView();
            loadMilenioTV(); // Carga de video bajo demanda
        } else if (viewId === 'denuncias') {
            document.getElementById('denuncias-view').classList.remove('hidden');
            denunciasBtn.classList.add('active');
        }
    }

    homeBtn.addEventListener('click', () => showView('home'));
    searchBtn.addEventListener('click', () => showView('search'));
    profileBtn.addEventListener('click', () => showView('profile'));
    forosBtn.addEventListener('click', () => showView('foros'));
    denunciasBtn.addEventListener('click', () => showView('denuncias'));

    const inputBusqueda = document.getElementById('input-busqueda');
    inputBusqueda.addEventListener('input', (e) => {
        const term = e.target.value;
        if (searchDebounceTimeout) clearTimeout(searchDebounceTimeout);
        searchDebounceTimeout = setTimeout(() => {
            executeSearch(term);
        }, 300);
    });

    // Premium Geo-Search Listener
    const btnGeoPremium = document.getElementById('btn-geo-search-premium');
    if (btnGeoPremium) {
        btnGeoPremium.addEventListener('click', () => {
            triggerGeoSearch();
        });
    }
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

                    ${user.rol === 'admin' || user.isAdmin ? `
                        <a href="/admin.html" class="btn-primary" style="display:block; text-decoration:none; padding:15px; border-radius:12px; font-weight:700; margin-top:20px; background:var(--accent); color:#000;">
                            <i class='bx bxs-dashboard'></i> Panel de Control
                        </a>
                    ` : ''}

                    <a href="/auth/logout" class="btn-secondary" style="display:block; text-decoration:none; padding:15px; border-radius:12px; font-weight:700; margin-top:10px;">Cerrar Sesión</a>
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

// --- LOGICA DE FOROS ---
function loadMilenioTV() {
    const milenio = document.getElementById('milenio-player');
    const rt = document.getElementById('rt-player');
    
    // Milenio (Link directo proporcionado por el usuario)
    if (milenio && !milenio.querySelector('iframe')) {
        milenio.innerHTML = `
            <iframe src="https://www.youtube.com/embed/tQ941SU5UR0?autoplay=0&mute=1" 
                    title="Milenio TV" allowfullscreen></iframe>
        `;
    }

    // RT Noticias (Official Embed)
    if (rt && !rt.querySelector('iframe')) {
        rt.innerHTML = `
            <iframe src="https://actualidad.rt.com/live-embed" 
                    title="RT Noticias" allowfullscreen></iframe>
        `;
    }

    // N+ Media (Direct Link)
    const nmas = document.getElementById('nmas-player');
    if (nmas && !nmas.querySelector('iframe')) {
        nmas.innerHTML = `
            <iframe src="https://www.youtube.com/embed/p2AzyIEuFak?autoplay=0&mute=1" 
                    title="N+ Media" allowfullscreen></iframe>
        `;
    }
    
    console.log('📺 Carrusel actualizado: Milenio + RT + N+');
}

async function renderForosView(categoria = 'Todo') {
    const container = document.getElementById('foros-container');
    container.innerHTML = '<div class="loading-foros">Cargando debate ciudadano...</div>';

    try {
        const res = await fetch(`/api/v1/foro?categoria=${encodeURIComponent(categoria)}`);
        const data = await res.json();
        
        if (!data || data.length === 0) {
            container.innerHTML = '<div class="empty-state"><i class="bx bx-message-rounded-x"></i><p>Aún no hay debate en esta categoría. ¡Sé el primero en comentar una noticia!</p></div>';
            return;
        }

        let html = '';
        data.forEach((item, index) => {
            const badgeClass = item.etiqueta_foro === 'Alerta de Seguridad' ? 'badge-seguridad' : 
                               (item.etiqueta_foro === 'Debate Público' ? 'badge-debate' : 'badge-ayuda');
            
            const lifePct = Math.round((item.promedio_valoracion / 5) * 100);
            const lifeColor = item.promedio_valoracion >= 4 ? '#22C55E' : (item.promedio_valoracion >= 3 ? '#FFCC00' : '#FF3B30');

            html += `
                <div class="foro-card" style="animation-delay: ${index * 0.1}s">
                    <div class="foro-header">
                        <span class="foro-badge ${badgeClass}">${item.etiqueta_foro}</span>
                        <div class="foro-life-bar">
                            <div class="foro-life-inner" style="width: ${lifePct}%; background: ${lifeColor};"></div>
                        </div>
                    </div>
                    
                    <div class="foro-main" onclick="openInAppBrowser('${item.link}')">
                        <div class="foro-main-text">
                            <h3 class="foro-title">${item.title}</h3>
                        </div>
                        <img src="${item.imageUrl}" class="foro-thumb" onerror="this.src='/img/placeholder-noticia.jpg'">
                    </div>

                    <div class="foro-comments-section">
                        ${item.comentarios_destacados.length > 0 ? item.comentarios_destacados.slice(0, 2).map(c => `
                            <div class="foro-comment-item">
                                <img src="${c.foto_perfil}" class="foro-comment-avatar">
                                <div class="foro-comment-content">
                                    <p class="foro-comment-user">${c.usuario_nombre}</p>
                                    <p class="foro-comment-text">${c.comentario}</p>
                                </div>
                            </div>
                        `).join('') : '<p style="font-size:12px; color:#666; text-align:center; padding:10px;">¡Sé el primero en comentar!</p>'}
                    </div>

                    <div class="foro-quick-action">
                        <input type="text" id="q-input-${item.id}" class="foro-input" placeholder="Únete al debate...">
                        <button class="foro-btn-send" onclick="postQuickComment('${item.id}')">
                            <i class='bx bxs-send'></i>
                        </button>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = '<div class="loading-foros">Error al cargar el foro. Reintenta.</div>';
    }
}

window.filtrarForo = function(categoria, el) {
    document.querySelectorAll('.chip-filter').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
    renderForosView(categoria);
};

async function postQuickComment(noticiaId) {
    const input = document.getElementById(`q-input-${noticiaId}`);
    const text = input.value.trim();
    if (!text) return;

    try {
        const r = await fetch('/api/v1/comentar', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({noticia_id: noticiaId, comentario: text})
        });
        
        if (r.ok) {
            input.value = '';
            // Recargamos solo la vista de foros para ver el nuevo comentario si es posible
            // Por simplicidad recargamos todo el feed del foro
            renderForosView(document.querySelector('.chip-filter.active').innerText.replace('🚨 ', '').replace('🗣️ ', '').replace('🤝 ', ''));
        } else {
            const data = await r.json();
            alert(data.error || 'Error al comentar');
        }
    } catch (e) {
        console.error('Error quick comment:', e);
    }
}
window.postQuickComment = postQuickComment;
window.renderForosView = renderForosView;

// --- LÓGICA DE VISOR IN-APP (v1.5) ---
window.openInAppBrowser = function(url) {
    const modal = document.getElementById('iframe-modal');
    const iframe = document.getElementById('news-iframe');
    
    if (!modal || !iframe) return;

    // Mostrar modal
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden'; 

    // Inyectar URL
    iframe.src = url;
    
    console.log('🌐 Cargando visor in-app para:', url);
};

// Configurar cierre del visor
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('close-iframe-btn')?.addEventListener('click', () => {
        const modal = document.getElementById('iframe-modal');
        const iframe = document.getElementById('news-iframe');
        
        if (modal) modal.classList.add('hidden');
        if (iframe) iframe.src = 'about:blank'; 
        document.body.style.overflow = '';
    });
});

// --- LÓGICA DE BÚSQUEDA GEO PREMIUM (v2.2) ---
async function triggerGeoSearch() {
    const overlay = document.getElementById('geo-search-overlay');
    const statusVal = document.getElementById('geo-status-val');
    const locVal = document.getElementById('geo-loc-val');
    const mainTitle = document.getElementById('geo-main-title');
    const mainDesc = document.getElementById('geo-main-desc');
    const errorActions = document.getElementById('geo-error-actions');
    const inputBusqueda = document.getElementById('input-busqueda');

    if (!overlay) return;

    // 1. Mostrar Overlay con escalado suave y ocultar barras UI
    overlay.classList.add('active');
    document.querySelectorAll('.top-bar, .bottom-nav').forEach(el => el.style.transform = 'translateY(100%)');
    if(document.querySelector('.top-bar')) document.querySelector('.top-bar').style.transform = 'translateY(-100%)';

    // Reiniciar interfaz
    statusVal.innerText = 'BUSCANDO SEÑAL...';
    locVal.innerText = 'DETECTANDO...';
    mainTitle.innerText = 'Buscando Noticias';
    mainDesc.innerText = 'Enlazando con el sistema de geovisión local.';
    errorActions.classList.add('hidden');

    const spawnParticle = () => {
        const p = document.createElement('div');
        p.className = 'geo-dot';
        p.style.left = Math.random() * 100 + '%';
        p.style.top = Math.random() * 100 + '%';
        const pc = document.getElementById('geo-particles');
        if(pc) pc.appendChild(p);
        setTimeout(() => p.remove(), 2000);
    };

    try {
        // 2. Obtener ubicación con Feedback visual
        statusVal.innerText = 'LOCALIZANDO GPS...';
        
        const position = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, { 
                enableHighAccuracy: true,
                timeout: 8000,
                maximumAge: 0
            });
        });

        const { latitude, longitude } = position.coords;
        locVal.innerText = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
        statusVal.innerText = 'SEÑAL BLOQUEADA';
        statusVal.classList.remove('pulse');

        // 3. Secuencia de Escaneo Cinematográfica
        mainTitle.innerText = 'Sincronizando Mapa';
        mainDesc.innerText = 'Identificando focos de interés en Tlaxcala.';
        
        for(let i=0; i<20; i++) {
            await new Promise(r => setTimeout(r, 120));
            spawnParticle();
            if(i === 7) mainDesc.innerText = 'Cruzando reportes de accidentes y política...';
            if(i === 14) mainDesc.innerText = 'Filtrando noticias de última hora...';
        }

        // 4. Búsqueda y Resultados
        const term = inputBusqueda ? inputBusqueda.value : '';
        const res = await fetch(`/api/v1/search?q=${encodeURIComponent(term)}&lat=${latitude}&lng=${longitude}`);
        const data = await res.json();

        mainTitle.innerText = '¡Mapa Actualizado!';
        mainDesc.innerText = `Se han detectado ${data.resultados.length} puntos de interés cercanos.`;
        
        await new Promise(r => setTimeout(r, 1500));
        
        renderSearchResults(data.resultados);
        closeGeoOverlay();

    } catch (error) {
        console.error('GeoSearch Error:', error);
        statusVal.innerText = 'ERROR DE VÍNCULO';
        mainTitle.innerText = 'No pudimos localizarte';
        mainDesc.innerText = 'La señal GPS es débil o no tenemos permisos. ¿Quieres buscar de todas formas?';
        errorActions.classList.remove('hidden');
    }
}

window.retryGeoSearch = () => {
    triggerGeoSearch();
};

window.closeGeoOverlay = () => {
    const overlay = document.getElementById('geo-search-overlay');
    if(!overlay) return;
    
    overlay.classList.remove('active');
    // Restaurar Barras UI
    document.querySelectorAll('.top-bar, .bottom-nav').forEach(el => el.style.transform = '');
};
