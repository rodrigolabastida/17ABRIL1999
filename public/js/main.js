let globalArticles = []; // Para acceder a ellos rápido al hacer click
let currentGeoPolled = false;
let searchDebounceTimeout = null;

document.addEventListener('DOMContentLoaded', () => {
    checkLocationPermission();
    setupBottomNav();
    checkUserSession();
});

async function checkUserSession() {
    try {
        const res = await fetch('/api/v1/feed'); // Usamos el feed para ver si viene el campo 'user', o crear un endpoint dedicado
        // Refinamos: el endpoint /api/v1/feed no devuelve user por defecto en el JSON actual. 
        // Creamos un fetch rápido a un endpoint que sí lo tenga o verificamos el estado.
        // Dado que modifiqué las respuestas de noticias, voy a usar un endpoint que siempre tenga el user
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
        fetchNews(); // Fetch sin params (Mayor vistas)
    } else {
        // Mostrar modal pidiendo permiso
        document.getElementById('location-modal-overlay').classList.remove('hidden');
    }
}

// Location Modal Buttons
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
        currentGeoPolled = true; // prevent loop locks
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                fetchNews(`?lat=${lat}&lng=${lng}`);
            },
            (err) => {
                console.warn('Geolocation Error', err);
                fetchNews(); // Fallback si falla
            }
        );
    } else {
        fetchNews();
    }
}

async function fetchNews(queryParams = '') {
    try {
        const response = await fetch(`/api/v1/feed${queryParams}`);
        const data = await response.json();
        
        if (data.noticiaPrincipal || data.noticiasSecundarias) {
            // Guardamos local para los modales
            globalArticles = [];
            if(data.noticiaPrincipal) globalArticles.push(data.noticiaPrincipal);
            if(data.noticiasSecundarias) globalArticles.push(...data.noticiasSecundarias);
            
            if(data.noticiaPrincipal){
                renderHero(data.noticiaPrincipal);
            } else {
                document.getElementById('hero-container').innerHTML = '';
            }
            renderFeed(data.noticiasSecundarias || []);
            
            attachClickBindings();
        }
    } catch (error) {
        console.error('Error fetching news:', error);
        document.getElementById('hero-container').innerHTML = '<p style="padding:20px;">Error cargando feed RSS.</p>';
    }
}

function renderHero(noticia) {
    const heroHTML = `
        <article class="hero-card" data-id="${noticia.id}">
            <div class="hero-img-wrapper">
                <img src="${noticia.imageUrl}" alt="${noticia.source}" onerror="this.onerror=null; this.src='/img/placeholder-noticia.jpg';">
                <div class="hero-gradient">
                    <h2 class="hero-title">${noticia.title}</h2>
                    <div class="hero-meta">
                        <span class="tag">${noticia.category}</span>
                        <span>•</span>
                        <span>${noticia.time}</span>
                        <span>•</span>
                        <span>${(noticia.views/1000).toFixed(1)}K vistas</span>
                    </div>
                </div>
            </div>
        </article>
    `;
    document.getElementById('hero-container').innerHTML = heroHTML;
}

function renderFeed(noticias) {
    const feedContainer = document.getElementById('feed-container');
    let feedHTML = '';
    
    noticias.forEach(noticia => {
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
    
    feedContainer.innerHTML = feedHTML;
}

// Modals Logic
let activeArticleLink = '';

function attachClickBindings() {
    // Vincular solo las activas en pantalla general
    const cards = document.querySelectorAll('#hero-container .hero-card, #feed-container .news-card');
    cards.forEach(card => {
        // Remover listener previo clonando (precaución)
        const old_card = card;
        const new_card = old_card.cloneNode(true);
        old_card.parentNode.replaceChild(new_card, old_card);
        
        new_card.addEventListener('click', () => {
            const id = new_card.getAttribute('data-id');
            const article = globalArticles.find(a => a.id === id);
            if(article && article.slug) {
                window.location.href = `/noticias/${article.slug}`;
            }
        });
    });
}

function openSummaryModal(article) {
    // Actualizar URL del navegador con el slug (Deep Link + History API)
    if (article.slug) {
        window.history.pushState({ articleId: article.id }, '', `/noticias/${article.slug}`);
    }
    
    const summaryImg = document.getElementById('summary-img');
    summaryImg.src = article.imageUrl;
    summaryImg.onerror = function() {
        this.onerror = null;
        this.src = '/img/placeholder-noticia.jpg';
    };
    
    document.getElementById('summary-source').textContent = article.source;
    document.getElementById('summary-title').textContent = article.title;
    document.getElementById('summary-desc').textContent = article.summary;
    activeArticleLink = article.link;
    document.getElementById('btn-open-external').href = article.link;
    
    // Switch Views
    document.getElementById('article-summary-modal').classList.remove('hidden');
}

// Botones dentro de los modales
document.getElementById('close-summary-btn').addEventListener('click', () => {
    document.getElementById('article-summary-modal').classList.add('hidden');
});

document.getElementById('btn-read-full').addEventListener('click', () => {
    // Abrir iframe y esconder resumen
    document.getElementById('article-summary-modal').classList.add('hidden');
    document.getElementById('news-iframe').src = activeArticleLink;
    document.getElementById('iframe-modal').classList.remove('hidden');
});

document.getElementById('close-iframe-btn').addEventListener('click', () => {
    // Cerrar iframe
    document.getElementById('iframe-modal').classList.add('hidden');
    document.getElementById('news-iframe').src = ""; // Stop loading or video
});

// ----------------------------------------------------
// NAVEGACIÓN BOTTOM Y MÓDULO DE BÚSQUEDA
// ----------------------------------------------------
function setupBottomNav() {
    const bottomNavItems = document.querySelectorAll('.bottom-nav-item');
    const heroContainer = document.getElementById('hero-container');
    const feedContainer = document.getElementById('feed-container');
    const vistaBusqueda = document.getElementById('vista-busqueda');

    // Botón Inicio (0)
    bottomNavItems[0].addEventListener('click', () => {
        bottomNavItems.forEach(i => i.classList.remove('active'));
        bottomNavItems[0].classList.add('active');
        heroContainer.classList.remove('hidden');
        feedContainer.classList.remove('hidden');
        vistaBusqueda.classList.add('hidden');
    });

    // Botón Buscar (1)
    bottomNavItems[1].addEventListener('click', () => {
        bottomNavItems.forEach(i => i.classList.remove('active'));
        bottomNavItems[1].classList.add('active');
        heroContainer.classList.add('hidden');
        feedContainer.classList.add('hidden');
        vistaBusqueda.classList.remove('hidden');
        document.getElementById('input-busqueda').focus();
    });
}

// Escuchar Input para Debounce
document.getElementById('input-busqueda').addEventListener('input', (e) => {
    const term = e.target.value.trim();
    clearTimeout(searchDebounceTimeout);
    
    const resultadosContainer = document.getElementById('contenedor-resultados-busqueda');
    const emptyStateHTML = `
        <div id="empty-state-search" class="empty-state">
            <i class='bx bx-search-alt-2'></i>
            <p>No se encontraron resultados para tu búsqueda.</p>
        </div>
    `;

    if (term === '') {
        document.getElementById('contenedor-terminos').innerHTML = '';
        resultadosContainer.innerHTML = emptyStateHTML;
        return;
    }

    searchDebounceTimeout = setTimeout(() => {
        executeSearch(term);
    }, 300);
});

async function executeSearch(term) {
    try {
        const response = await fetch(`/api/v1/search?q=${encodeURIComponent(term)}`);
        const data = await response.json();
        renderSearch(data.resultados, data.relacionados);
    } catch (e) {
        console.error('Error en búsqueda:', e);
    }
}

function renderSearch(resultados, relacionados) {
    const terminosContainer = document.getElementById('contenedor-terminos');
    const resultadosContainer = document.getElementById('contenedor-resultados-busqueda');
    
    // Interfaz Chips
    if (relacionados && relacionados.length > 0) {
        terminosContainer.innerHTML = relacionados.map(r => `<div class="chip" onclick="fillSearch('${r}')">${r}</div>`).join('');
    } else {
        terminosContainer.innerHTML = '';
    }

    // Interfaz Resultados
    if (resultados && resultados.length > 0) {
        // Acoplar al array global sin duplicar
        resultados.forEach(r => {
            if(!globalArticles.find(a => a.id === r.id)) globalArticles.push(r);
        });

        let feedHTML = '';
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
        
        // Agregar click listener al DOM inyectado para búsqueda
        const searchCards = document.querySelectorAll('#contenedor-resultados-busqueda .news-card');
        searchCards.forEach(card => {
            card.addEventListener('click', () => {
                const id = card.getAttribute('data-id');
                const article = globalArticles.find(a => a.id === id);
                if(article && article.slug) {
                    window.location.href = `/noticias/${article.slug}`;
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

// Inyección programática si tocan un chip
window.fillSearch = function(term) {
    const input = document.getElementById('input-busqueda');
    input.value = term;
    executeSearch(term);
};
