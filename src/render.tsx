import { jsx } from 'hono/jsx';

export const Render = ({ isAuthenticated, showWarning }: { isAuthenticated: boolean; showWarning: boolean }) => {
	if (!isAuthenticated) {
		return (
			<html>
				<head>
					<meta charset="UTF-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1.0" />
					<title>登录</title>
					<script src="https://cdn.tailwindcss.com"></script>
				</head>
				<body class="bg-gray-100 flex items-center justify-center h-screen">
					<div class="w-full max-w-xs">
						<form id="login-form" class="bg-white shadow-md rounded px-8 pt-6 pb-8 mb-4">
							<div class="mb-4">
								<label class="block text-gray-700 text-sm font-bold mb-2" for="auth-key">
									ACCESS_KEY
								</label>
								<input
									class="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
									id="auth-key"
									type="password"
									placeholder="******************"
								/>
							</div>
							<div class="flex items-center justify-between">
								<button
									class="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline"
									type="submit"
								>
									登录
								</button>
							</div>
						</form>
					</div>
					<script
						dangerouslySetInnerHTML={{
							__html: `
                                document.getElementById('login-form').addEventListener('submit', async function(e) {
                                    e.preventDefault();
                                    const key = document.getElementById('auth-key').value;
                                    const response = await fetch(window.location.href, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ key }),
                                    });
                                    if (response.ok) {
                                        window.location.reload();
                                    } else {
                                        alert('登录失败');
                                    }
                                });
                            `,
						}}
					></script>
				</body>
			</html>
		);
	}

	return (
		<html>
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>Gemini API 密钥管理</title>
				<script src="https://cdn.tailwindcss.com"></script>
			</head>
			<body class="bg-slate-100 text-slate-800">
				{showWarning && (
					<div class="bg-yellow-100 border-l-4 border-yellow-500 text-yellow-700 p-3 mb-4" role="alert">
						<strong class="font-bold">安全警告：</strong>
						<span class="block">当前 HOME_ACCESS_KEY 或 AUTH_KEY 为默认值，请尽快修改环境变量并重新部署 Worker！</span>
					</div>
				)}
				<div class="flex h-screen relative">
					{/* 移动端汉堡菜单按钮 */}
					<button
						id="sidebar-toggle"
						class="lg:hidden fixed top-4 left-4 z-50 p-2 bg-slate-800 text-white rounded-lg shadow-lg hover:bg-slate-700 transition-colors"
					>
						<svg id="menu-icon" class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
						</svg>
						<svg id="close-icon" class="w-6 h-6 hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
						</svg>
					</button>

					{/* 遮罩层 */}
					<div
						id="sidebar-backdrop"
						class="lg:hidden fixed inset-0 bg-black/50 z-30 hidden transition-opacity"
					></div>

					{/* 侧边栏 */}
					<div
						id="sidebar"
						class="fixed lg:relative w-64 h-full bg-slate-800 text-white p-4 flex flex-col z-40 transform -translate-x-full lg:translate-x-0 transition-transform duration-300 ease-in-out"
					>
						<h1 class="text-2xl font-bold mb-8 text-sky-400 mt-12 lg:mt-0">管理面板</h1>
						<nav class="flex flex-col space-y-2">
							<a href="#" id="nav-keys-list" class="block py-2.5 px-4 rounded-lg bg-slate-700 transition-colors">
								🔑 密钥列表
							</a>
							<a href="#" id="nav-add-keys" class="block py-2.5 px-4 rounded-lg hover:bg-slate-700 transition-colors">
								➕ 添加密钥
							</a>
							<a href="#" id="nav-paid-rules" class="block py-2.5 px-4 rounded-lg hover:bg-slate-700 transition-colors">
								💰 付费规则
							</a>
							<a href="#" id="nav-stats" class="block py-2.5 px-4 rounded-lg hover:bg-slate-700 transition-colors">
								📊 统计面板
							</a>
						</nav>
					</div>
					<div class="flex-1 p-8 pt-16 lg:pt-8 overflow-y-auto">
						<div id="page-keys-list">
							<h2 class="text-3xl font-bold mb-6 text-slate-700">密钥列表</h2>
							<div class="bg-white p-6 rounded-lg shadow-sm">
								<div class="flex justify-between items-center mb-4">
									<h3 class="text-xl font-semibold text-slate-600">已存储的密钥</h3>
									<div class="space-x-2">
										<button
											id="check-keys-btn"
											class="px-4 py-2 bg-teal-500 text-white rounded-lg hover:bg-teal-600 transition-colors shadow-sm"
										>
											一键检查
										</button>
										<button
											id="refresh-keys-btn"
											class="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 transition-colors shadow-sm"
										>
											刷新
										</button>
										<button
											id="select-invalid-keys-btn"
											class="px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors shadow-sm ml-2 hidden"
										>
											勾选无效密钥
										</button>
									</div>
								</div>
								<div class="max-h-96 overflow-y-auto border rounded-lg">
									<table id="keys-table" class="w-full text-left">
										<thead class="bg-slate-50">
											<tr class="border-b border-slate-200">
												<th class="p-3 w-6">
													<input type="checkbox" id="select-all-keys" class="rounded border-slate-300" />
												</th>
												<th class="p-3 text-slate-600 font-semibold">API 密钥</th>
												<th class="p-3 text-slate-600 font-semibold">类型</th>
												<th class="p-3 text-slate-600 font-semibold">状态</th>
												<th class="p-3 text-slate-600 font-semibold">分组</th>
												<th class="p-3 text-slate-600 font-semibold">最后检查时间</th>
												<th class="p-3 text-slate-600 font-semibold">失败次数</th>
											</tr>
										</thead>
										<tbody class="divide-y divide-slate-200"></tbody>
									</table>
								</div>
								<div id="pagination-controls" class="mt-4 flex justify-center items-center">
									<button
										id="prev-page-btn"
										class="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 transition-colors disabled:opacity-50 shadow-sm"
										disabled
									>
										上一页
									</button>
									<span id="page-info" class="mx-4 text-slate-600"></span>
									<button
										id="next-page-btn"
										class="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 transition-colors disabled:opacity-50 shadow-sm"
										disabled
									>
										下一页
									</button>
								</div>
								<button
									id="delete-selected-keys-btn"
									class="mt-4 w-full px-4 py-2 bg-rose-500 text-white rounded-lg hover:bg-rose-600 transition-colors hidden shadow-sm"
								>
									删除选中
								</button>
							</div>
						</div>
						<div id="page-add-keys" class="hidden">
							<h2 class="text-3xl font-bold mb-6 text-slate-700">添加密钥</h2>
							<div class="bg-white p-6 rounded-lg shadow-sm">
								<h3 class="text-xl font-semibold mb-4 text-slate-600">批量添加密钥</h3>
								<form id="add-keys-form">
									<textarea
										id="api-keys"
										class="w-full h-48 p-3 border rounded-lg bg-slate-50 focus:ring-2 focus:ring-teal-500 focus:border-teal-500 transition"
										placeholder="请输入API密钥，每行一个"
									></textarea>
									<div class="mt-4 flex gap-4">
										<button
											type="button"
											id="add-free-keys-btn"
											class="flex-1 px-4 py-2.5 bg-sky-500 text-white rounded-lg hover:bg-sky-600 transition-colors shadow-sm"
										>
											➕ 添加免费密钥
										</button>
										<button
											type="button"
											id="add-paid-keys-btn"
											class="flex-1 px-4 py-2.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 transition-colors shadow-sm"
										>
											💰 添加付费密钥
										</button>
									</div>
								</form>
							</div>
						</div>
						<div id="page-paid-rules" class="hidden">
							<h2 class="text-3xl font-bold mb-6 text-slate-700">💰 付费规则</h2>
							<div class="bg-white p-6 rounded-lg shadow-sm mb-6">
								<h3 class="text-xl font-semibold mb-4 text-slate-600">付费模型规则</h3>
								<p class="text-sm text-slate-500 mb-4">
									配置哪些模型使用付费密钥。每行一个规则，支持通配符 * 匹配任意字符。
								</p>
								<textarea
									id="paid-rules-input"
									class="w-full h-48 p-3 border rounded-lg bg-slate-50 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 transition font-mono text-sm"
									placeholder="gemini-2.0-pro&#10;gemini-ultra&#10;*-exp-*"
								></textarea>
								<button
									id="save-paid-rules-btn"
									class="mt-4 px-6 py-2.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 transition-colors shadow-sm"
								>
									💾 保存规则
								</button>
							</div>
							<div class="bg-slate-50 p-4 rounded-lg border border-slate-200">
								<h4 class="font-semibold text-slate-700 mb-2">使用说明</h4>
								<ul class="text-sm text-slate-600 space-y-1">
									<li>• 精确匹配：<code class="bg-slate-200 px-1 rounded">gemini-2.0-pro</code></li>
									<li>• 前缀匹配：<code class="bg-slate-200 px-1 rounded">gemini-ultra*</code></li>
									<li>• 包含匹配：<code class="bg-slate-200 px-1 rounded">*-exp-*</code></li>
									<li>• 如果付费密钥用完，会自动降级到免费密钥</li>
								</ul>
							</div>
						</div>
						<div id="page-stats" class="hidden">
							<h2 class="text-3xl font-bold mb-6 text-slate-700">📊 统计面板</h2>
							<div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
								<div class="bg-white p-4 rounded-lg shadow-sm">
									<p class="text-sm text-slate-500">24小时请求数</p>
									<p id="stat-total-requests" class="text-2xl font-bold text-sky-600">--</p>
								</div>
								<div class="bg-white p-4 rounded-lg shadow-sm">
									<p class="text-sm text-slate-500">成功率</p>
									<p id="stat-success-rate" class="text-2xl font-bold text-emerald-600">--</p>
								</div>
								<div class="bg-white p-4 rounded-lg shadow-sm">
									<p class="text-sm text-slate-500">429 限流次数</p>
									<p id="stat-rate-limited" class="text-2xl font-bold text-amber-600">--</p>
								</div>
								<div class="bg-white p-4 rounded-lg shadow-sm">
									<p class="text-sm text-slate-500">平均响应时间</p>
									<p id="stat-avg-response" class="text-2xl font-bold text-violet-600">--</p>
								</div>
							</div>
							<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
								<div class="bg-white p-6 rounded-lg shadow-sm">
									<h3 class="text-lg font-semibold mb-4 text-slate-600">模型使用统计</h3>
									<div class="max-h-64 overflow-y-auto">
										<table class="w-full text-sm">
											<thead class="bg-slate-50">
												<tr>
													<th class="p-2 text-left">模型</th>
													<th class="p-2 text-right">请求数</th>
													<th class="p-2 text-right">平均响应(ms)</th>
												</tr>
											</thead>
											<tbody id="model-stats-body" class="divide-y"></tbody>
										</table>
									</div>
								</div>
								<div class="bg-white p-6 rounded-lg shadow-sm">
									<h3 class="text-lg font-semibold mb-4 text-slate-600">Key 使用统计</h3>
									<div class="max-h-64 overflow-y-auto">
										<table class="w-full text-sm">
											<thead class="bg-slate-50">
												<tr>
													<th class="p-2 text-left">Key (后8位)</th>
													<th class="p-2 text-right">调用次数</th>
													<th class="p-2 text-right">平均响应(ms)</th>
													<th class="p-2 text-center">状态</th>
												</tr>
											</thead>
											<tbody id="key-stats-body" class="divide-y"></tbody>
										</table>
									</div>
								</div>
							</div>
							<button id="refresh-stats-btn" class="mt-4 px-4 py-2 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 transition-colors shadow-sm">
								刷新统计
							</button>
						</div>
					</div>
				</div>

				<script
					dangerouslySetInnerHTML={{
						__html: `
								document.addEventListener('DOMContentLoaded', () => {
										const addKeysForm = document.getElementById('add-keys-form');
										const apiKeysTextarea = document.getElementById('api-keys');
										const refreshKeysBtn = document.getElementById('refresh-keys-btn');
										const keysTableBody = document.querySelector('#keys-table tbody');
										const selectAllCheckbox = document.getElementById('select-all-keys');
										const deleteSelectedBtn = document.getElementById('delete-selected-keys-btn');
										const checkKeysBtn = document.getElementById('check-keys-btn');
										const paginationControls = document.getElementById('pagination-controls');
										const prevPageBtn = document.getElementById('prev-page-btn');
										const nextPageBtn = document.getElementById('next-page-btn');
										const pageInfoSpan = document.getElementById('page-info');
										const selectInvalidKeysBtn = document.getElementById('select-invalid-keys-btn');

										const navKeysList = document.getElementById('nav-keys-list');
										const navAddKeys = document.getElementById('nav-add-keys');
										const navPaidRules = document.getElementById('nav-paid-rules');
										const navStats = document.getElementById('nav-stats');
										const pageKeysList = document.getElementById('page-keys-list');
										const pageAddKeys = document.getElementById('page-add-keys');
										const pagePaidRules = document.getElementById('page-paid-rules');
										const pageStats = document.getElementById('page-stats');
										const refreshStatsBtn = document.getElementById('refresh-stats-btn');
										const addFreeKeysBtn = document.getElementById('add-free-keys-btn');
										const addPaidKeysBtn = document.getElementById('add-paid-keys-btn');
										const paidRulesInput = document.getElementById('paid-rules-input');
										const savePaidRulesBtn = document.getElementById('save-paid-rules-btn');

										let currentPage = 1;
										const pageSize = 50;
										let totalPages = 1;

										// 侧边栏切换逻辑
										const sidebarToggle = document.getElementById('sidebar-toggle');
										const sidebar = document.getElementById('sidebar');
										const sidebarBackdrop = document.getElementById('sidebar-backdrop');
										const menuIcon = document.getElementById('menu-icon');
										const closeIcon = document.getElementById('close-icon');

										const toggleSidebar = (show) => {
											if (show) {
												sidebar.classList.remove('-translate-x-full');
												sidebarBackdrop.classList.remove('hidden');
												menuIcon.classList.add('hidden');
												closeIcon.classList.remove('hidden');
											} else {
												sidebar.classList.add('-translate-x-full');
												sidebarBackdrop.classList.add('hidden');
												menuIcon.classList.remove('hidden');
												closeIcon.classList.add('hidden');
											}
										};

										if (sidebarToggle) {
											sidebarToggle.addEventListener('click', () => {
												const isOpen = !sidebar.classList.contains('-translate-x-full');
												toggleSidebar(!isOpen);
											});
										}

										if (sidebarBackdrop) {
											sidebarBackdrop.addEventListener('click', () => {
												toggleSidebar(false);
											});
										}

										// 点击导航项后在移动端关闭侧边栏
										const closeSidebarOnNav = () => {
											if (window.innerWidth < 1024) {
												toggleSidebar(false);
											}
										};

										const showPage = (pageId) => {
									[pageKeysList, pageAddKeys, pagePaidRules, pageStats].forEach(page => {
										if (page && page.id === pageId) {
											page.classList.remove('hidden');
										} else if (page) {
											page.classList.add('hidden');
										}
									});
									[navKeysList, navAddKeys, navPaidRules, navStats].forEach(nav => {
										if (nav && nav.id === 'nav-' + pageId.replace('page-', '')) {
											nav.classList.add('bg-slate-700');
											nav.classList.remove('hover:bg-slate-700');
										} else if (nav) {
											nav.classList.remove('bg-slate-700');
											nav.classList.add('hover:bg-slate-700');
										}
									});
									if (pageId === 'page-stats') {
										fetchAndRenderStats();
									}
									if (pageId === 'page-paid-rules') {
										fetchAndRenderPaidRules();
									}
								};

								navKeysList.addEventListener('click', (e) => {
									e.preventDefault();
									showPage('page-keys-list');
									closeSidebarOnNav();
								});

								navAddKeys.addEventListener('click', (e) => {
									e.preventDefault();
									showPage('page-add-keys');
									closeSidebarOnNav();
								});

								navPaidRules.addEventListener('click', (e) => {
									e.preventDefault();
									showPage('page-paid-rules');
									closeSidebarOnNav();
								});

								navStats.addEventListener('click', (e) => {
									e.preventDefault();
									showPage('page-stats');
									closeSidebarOnNav();
								});

										// 统计数据获取和渲染
										const fetchAndRenderStats = async () => {
											try {
												const refreshBtn = document.getElementById('refresh-stats-btn');
												if (refreshBtn) refreshBtn.innerHTML = '加载中...';
												
												const response = await fetch('/api/stats');
												if (!response.ok) throw new Error('Failed to fetch stats');
												const data = await response.json();

												document.getElementById('stat-total-requests').textContent = data.overview.totalRequests.toLocaleString();
												document.getElementById('stat-success-rate').textContent = data.overview.successRate + '%';
												document.getElementById('stat-rate-limited').textContent = data.overview.rateLimitedCount.toLocaleString();
												document.getElementById('stat-avg-response').textContent = data.overview.avgResponseTime + 'ms';

												const modelStatsBody = document.getElementById('model-stats-body');
												modelStatsBody.innerHTML = data.modelStats.length === 0 
													? '<tr><td colspan="3" class="p-2 text-center text-slate-500">暂无数据</td></tr>'
													: data.modelStats.map(m => \`
														<tr class="hover:bg-slate-50">
															<td class="p-2 font-mono text-sm">\${m.model}</td>
															<td class="p-2 text-right">\${m.requests.toLocaleString()}</td>
															<td class="p-2 text-right">\${m.avgResponseTime}</td>
														</tr>
													\`).join('');

												const keyStatsBody = document.getElementById('key-stats-body');
												keyStatsBody.innerHTML = data.keyStats.length === 0
													? '<tr><td colspan="4" class="p-2 text-center text-slate-500">暂无数据</td></tr>'
													: data.keyStats.map(k => \`
														<tr class="hover:bg-slate-50">
															<td class="p-2 font-mono text-sm">...\${k.apiKey.slice(-8)}</td>
															<td class="p-2 text-right">\${k.usageCount.toLocaleString()}</td>
															<td class="p-2 text-right">\${k.avgResponseTime}</td>
															<td class="p-2 text-center"><span class="px-2 py-1 rounded text-xs \${k.keyGroup === 'normal' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}">\${k.keyGroup === 'normal' ? '正常' : '异常'}</span></td>
														</tr>
													\`).join('');
											} catch (error) {
												console.error('Failed to fetch stats:', error);
											} finally {
												const refreshBtn = document.getElementById('refresh-stats-btn');
												if (refreshBtn) refreshBtn.innerHTML = '刷新统计';
											}
										};

										if (refreshStatsBtn) {
											refreshStatsBtn.addEventListener('click', fetchAndRenderStats);
										}


										const updatePaginationControls = () => {
												pageInfoSpan.textContent = \`第 \${currentPage} / \${totalPages} 页\`;
												prevPageBtn.disabled = currentPage === 1;
												nextPageBtn.disabled = currentPage >= totalPages;
										};

										const fetchAndRenderKeys = async () => {
												keysTableBody.innerHTML = '<tr><td colspan="7" class="p-2 text-center">加载中...</td></tr>';
												try {
												  const response = await fetch(\`/api/keys?page=\${currentPage}&pageSize=\${pageSize}\`);
												  const { keys, total } = await response.json();
												  
												  totalPages = Math.ceil(total / pageSize);
												  keysTableBody.innerHTML = '';
												  if (keys.length === 0) {
												    keysTableBody.innerHTML = '<tr><td colspan="8" class="p-2 text-center">暂无密钥</td></tr>';
												  } else {
												    keys.forEach(key => {
												      const statusMap = { normal: '正常', abnormal: '异常' };
								      const keyTypeMap = { free: '免费', paid: '付费' };
								      const row = document.createElement('tr');
								      row.className = 'hover:bg-slate-50 transition-colors';
								      row.dataset.key = key.api_key;
								      const keyTypeBadge = key.key_type === 'paid' 
								        ? '<span class="px-2 py-1 rounded text-xs bg-emerald-100 text-emerald-700">💰 付费</span>'
								        : '<span class="px-2 py-1 rounded text-xs bg-slate-100 text-slate-600">免费</span>';
								      row.innerHTML = \`
								        <td class="p-3 w-6"><input type="checkbox" class="key-checkbox rounded border-slate-300" data-key="\${key.api_key}" /></td>
								        <td class="p-3 font-mono text-sm text-slate-700">\${key.api_key}</td>
								        <td class="p-3">\${keyTypeBadge}</td>
								        <td class="p-3 status-cell">\${statusMap[key.status] || key.status}</td>
								        <td class="p-3">\${statusMap[key.key_group] || key.key_group}</td>
								        <td class="p-3 text-sm text-slate-500">\${key.last_checked_at ? new Date(key.last_checked_at).toLocaleString() : 'N/A'}</td>
								        <td class="p-3 text-center">\${key.failed_count}</td>
								      \`;
												      keysTableBody.appendChild(row);
												    });
												  }
												  updatePaginationControls();
												} catch (error) {
												  keysTableBody.innerHTML = '<tr><td colspan="8" class="p-2 text-center text-red-500">加载失败</td></tr>';
												  console.error('Failed to fetch keys:', error);
												}
										};

										const updateDeleteButtonVisibility = () => {
												const selectedKeys = document.querySelectorAll('.key-checkbox:checked');
												deleteSelectedBtn.classList.toggle('hidden', selectedKeys.length === 0);
										};

										keysTableBody.addEventListener('change', (e) => {
												if (e.target.classList.contains('key-checkbox')) {
												  updateDeleteButtonVisibility();
												}
										});

										selectAllCheckbox.addEventListener('change', () => {
												const checkboxes = document.querySelectorAll('.key-checkbox');
												checkboxes.forEach(checkbox => {
												  checkbox.checked = selectAllCheckbox.checked;
												});
												updateDeleteButtonVisibility();
										});

										deleteSelectedBtn.addEventListener('click', async () => {
												const selectedKeys = Array.from(document.querySelectorAll('.key-checkbox:checked')).map(cb => cb.dataset.key);
												if (selectedKeys.length === 0) {
												  alert('请至少选择一个密钥。');
												  return;
												}

												if (!confirm(\`确定要删除选中的 \${selectedKeys.length} 个密钥吗？\`)) {
												  return;
												}

												try {
												  const response = await fetch('/api/keys', {
												    method: 'DELETE',
												    headers: { 'Content-Type': 'application/json' },
												    body: JSON.stringify({ keys: selectedKeys }),
												  });
												  const result = await response.json();
												  if (response.ok) {
												    alert(result.message || '密钥删除成功。');
												    fetchAndRenderKeys();
												    updateDeleteButtonVisibility();
												    selectAllCheckbox.checked = false;
												  } else {
												    alert(\`删除密钥失败: \${result.error || '未知错误'}\`);
												  }
												} catch (error) {
												  alert('请求失败，请检查网络连接。');
												  console.error('Failed to delete keys:', error);
												}
										});

										checkKeysBtn.addEventListener('click', async () => {
											const rows = keysTableBody.querySelectorAll('tr[data-key]');
											const keysToCheck = Array.from(rows).map(row => row.dataset.key);

											rows.forEach(row => {
												const statusCell = row.querySelector('.status-cell');
												if (statusCell) {
													statusCell.textContent = '检查中...';
													statusCell.className = 'p-2 status-cell text-gray-500';
												}
											});

											try {
												const response = await fetch('/api/keys/check', {
													method: 'POST',
													headers: { 'Content-Type': 'application/json' },
													body: JSON.stringify({ keys: keysToCheck }),
												});
												if (response.ok) {
													alert('检查完成。');
													fetchAndRenderKeys();
												} else {
													const result = await response.json();
													alert(\`检查密钥失败: \${result.error || '未知错误'}\`);
												}
											} catch (error) {
												alert('请求失败，请检查网络连接。');
												console.error('Failed to check keys:', error);
											}
										});

										selectInvalidKeysBtn.addEventListener('click', () => {
											const rows = keysTableBody.querySelectorAll('tr');
											rows.forEach(row => {
												const statusCell = row.querySelector('.status-cell');
												if (statusCell && statusCell.textContent === '无效') {
													const checkbox = row.querySelector('.key-checkbox');
													if (checkbox) {
														checkbox.checked = true;
													}
												}
											});
											updateDeleteButtonVisibility();
										});

										// 添加密钥函数
								const addKeys = async (keyType) => {
									const keys = apiKeysTextarea.value.split('\n').map(k => k.trim()).filter(k => k !== '');
									if (keys.length === 0) {
										alert('请输入至少一个API密钥。');
										return;
									}
									try {
										const response = await fetch('/api/keys', {
											method: 'POST',
											headers: { 'Content-Type': 'application/json' },
											body: JSON.stringify({ keys, keyType }),
										});
										const result = await response.json();
										if (response.ok) {
											alert(result.message || '密钥添加成功。');
											apiKeysTextarea.value = '';
											fetchAndRenderKeys();
										} else {
											alert(\`添加密钥失败: \${result.error || '未知错误'}\`);
										}
									} catch (error) {
										alert('请求失败，请检查网络连接。');
										console.error('Failed to add keys:', error);
									}
								};

								addFreeKeysBtn.addEventListener('click', () => addKeys('free'));
								addPaidKeysBtn.addEventListener('click', () => addKeys('paid'));

								// 付费规则相关函数
								const fetchAndRenderPaidRules = async () => {
									try {
										const response = await fetch('/api/paid-rules');
										if (!response.ok) throw new Error('Failed to fetch paid rules');
										const data = await response.json();
										paidRulesInput.value = data.rules.map(r => r.pattern).join('\n');
									} catch (error) {
										console.error('Failed to fetch paid rules:', error);
									}
								};

								savePaidRulesBtn.addEventListener('click', async () => {
									const patterns = paidRulesInput.value.split('\n').map(p => p.trim()).filter(p => p !== '');
									try {
										const response = await fetch('/api/paid-rules', {
											method: 'POST',
											headers: { 'Content-Type': 'application/json' },
											body: JSON.stringify({ patterns }),
										});
										const result = await response.json();
										if (response.ok) {
											alert(result.message || '规则保存成功。');
										} else {
											alert(\`保存失败: \${result.error || '未知错误'}\`);
										}
									} catch (error) {
					alert('请求失败，请检查网络连接。');
				console.error('Failed to save paid rules:', error);
									}
								});

				refreshKeysBtn.addEventListener('click', fetchAndRenderKeys);

										prevPageBtn.addEventListener('click', () => {
												if (currentPage > 1) {
					currentPage--;
				fetchAndRenderKeys();
												}
										});

										nextPageBtn.addEventListener('click', () => {
												if (currentPage < totalPages) {
					currentPage++;
				fetchAndRenderKeys();
												}
										});

				// Initial load
				fetchAndRenderKeys();
								});
				`,
					}}
				></script>
			</body>
		</html >
	);
};
