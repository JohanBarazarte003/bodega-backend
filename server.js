require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

// =========================================================================
// 1. CONFIGURACIÓN Y LIMPIEZA DE CREDENCIALES DE SUPABASE
// =========================================================================
let supabaseUrl = (process.env.SUPABASE_URL || '').trim();
let supabaseKey = (process.env.SUPABASE_KEY || '').trim();
if (supabaseUrl.endsWith('/')) {
    supabaseUrl = supabaseUrl.slice(0, -1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

console.log(`✓ Cliente de Supabase configurado para: ${supabaseUrl}`);

// =========================================================================
// 2. RUTAS DE CLIENTES
// =========================================================================

app.get('/api/clientes', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('clientes')
            .select('*')
            .order('nombre');
        if (error) throw error;
        res.json(data || []);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.post('/api/clientes', async (req, res) => {
    try {
        const { nombre, telefono } = req.body;
        const { data, error } = await supabase
            .from('clientes')
            .insert([{ nombre, telefono: telefono || "", deuda_usd: 0.00 }])
            .select();
        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.delete('/api/clientes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('clientes')
            .delete()
            .eq('id', id);
            
        if (error) throw error;
        res.json({ mensaje: "Cliente eliminado correctamente" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// 3. RUTAS DE PRODUCTOS / INVENTARIO
// =========================================================================
app.get('/api/productos', async (req, res) => {
    try {
        const { data, error } = await supabase.from('productos').select('*').order('nombre');
        if (error) throw error;
        res.json(data || []);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.post('/api/productos', async (req, res) => {
    try {
        const { nombre, categoria, precio_usd } = req.body;
        const { data, error } = await supabase
            .from('productos')
            .insert([{ nombre, categoria, precio_usd: parseFloat(precio_usd) }])
            .select();
        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.put('/api/productos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { precio_usd } = req.body;
        
        const { data, error } = await supabase
            .from('productos')
            .update({ precio_usd: parseFloat(precio_usd) })
            .eq('id', id)
            .select();
            
        if (error) throw error;
        res.json({ mensaje: "Precio actualizado con éxito", producto: data[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/productos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('productos')
            .delete()
            .eq('id', id);
            
        if (error) throw error;
        res.json({ mensaje: "Producto eliminado correctamente" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// 4. OPERACIONES ADMINISTRATIVAS (FIAR Y ABONAR)
// =========================================================================

app.post('/api/fiar', async (req, res) => {
    try {
        const { cliente_id, producto_id, cantidad } = req.body;
        const cant = parseInt(cantidad) || 1;

        // Consultas puntuales en paralelo para mejorar el performance
        const [cRes, pRes] = await Promise.all([
            supabase.from('clientes').select('*').eq('id', cliente_id),
            supabase.from('productos').select('*').eq('id', producto_id)
        ]);

        if (!cRes.data?.length || !pRes.data?.length) {
            return res.status(404).json({ error: "Registros no encontrados" });
        }

        const cliente = cRes.data[0];
        const producto = pRes.data[0];
        const subtotal = parseFloat((producto.precio_usd * cant).toFixed(2));
        const nuevaDeuda = parseFloat((parseFloat(cliente.deuda_usd || 0) + subtotal).toFixed(2));

        // Inserción del consumo individual
        const { error: insError } = await supabase.from('consumos').insert([{
            cliente_id: cliente.id, 
            cliente_nombre: cliente.nombre,
            producto: producto.nombre, 
            cantidad: cant,
            precio_unitario_usd: producto.precio_usd, 
            subtotal_usd: subtotal
        }]);
        if (insError) throw insError;

        // Actualización del consolidado en el cliente
        const { error: updError } = await supabase
            .from('clientes')
            .update({ deuda_usd: nuevaDeuda })
            .eq('id', cliente.id);
        if (updError) throw updError;

        res.json({ mensaje: "Consumo cargado con éxito", saldo: nuevaDeuda });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.get('/api/consumos/:cliente_id', async (req, res) => {
    try {
        const { cliente_id } = req.params;
        const { data, error } = await supabase
            .from('consumos')
            .select('*')
            .eq('cliente_id', cliente_id)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ABONO PARCIAL O COMPLETO MANUAL
app.post('/api/pagos', async (req, res) => {
    try {
        const { cliente_id, monto, moneda, tasa } = req.body;
        const montoInput = parseFloat(monto);
        const tasaDia = parseFloat(tasa);
        
        const { data: cData } = await supabase.from('clientes').select('*').eq('id', cliente_id);
        if (!cData?.length) return res.status(404).json({ error: "Cliente no encontrado" });
        
        const cliente = cData[0];
        const deudaActual = parseFloat(cliente.deuda_usd || 0);
        
        let abonoUsd = 0;
        let abonoBs = 0;

        if (moneda === 'BS') {
            abonoBs = montoInput;
            abonoUsd = parseFloat((montoInput / tasaDia).toFixed(2)); 
        } else {
            abonoUsd = montoInput;
            abonoBs = parseFloat((montoInput * tasaDia).toFixed(2));  
        }
        
        let nuevaDeuda = parseFloat((deudaActual - abonoUsd).toFixed(2));
        if (nuevaDeuda <= 0.01) nuevaDeuda = 0; 

        // 1. Registrar auditoría del pago
        await supabase.from('pagos').insert([{
            cliente_id: cliente.id,
            monto_usd: abonoUsd,
            monto_bs: abonoBs,
            tasa_usada: tasaDia,
            notes: `Abono registrado en ${moneda}`
        }]);

        // 2. Si la cuenta quedó en 0, limpiamos los consumos activos de este ciclo
        if (nuevaDeuda === 0) {
            await supabase.from('consumos').delete().eq('cliente_id', cliente.id);
        }

        // 3. Modificamos la ficha consolidada del cliente
        await supabase.from('clientes').update({ deuda_usd: nuevaDeuda }).eq('id', cliente.id);

        res.json({ mensaje: "Pago registrado con éxito", nuevo_saldo_usd: nuevaDeuda });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// NUEVA RUTA: SALDAR DEUDA POR COMPLETO (BOTÓN DE BORRADO DE EXPEDIENTE)
app.post('/api/saldar-todo', async (req, res) => {
    try {
        const { cliente_id, tasa } = req.body;
        const tasaDia = parseFloat(tasa);

        const { data: cData } = await supabase.from('clientes').select('*').eq('id', cliente_id);
        if (!cData?.length) return res.status(404).json({ error: "Cliente no encontrado" });

        const cliente = cData[0];
        const deudaCierre = parseFloat(cliente.deuda_usd || 0);

        if (deudaCierre === 0) {
            return res.json({ mensaje: "El cliente ya no tiene deudas pendientes", nuevo_saldo_usd: 0 });
        }

        const montoBsEquivalente = parseFloat((deudaCierre * tasaDia).toFixed(2));

        // 1. Guardamos registro en la tabla de pagos indicando el cierre forzado del ciclo
        await supabase.from('pagos').insert([{
            cliente_id: cliente.id,
            monto_usd: deudaCierre,
            monto_bs: montoBsEquivalente,
            tasa_usada: tasaDia,
            notes: "Saldado completo - Cierre automático de ciclo de deudas"
        }]);

        // 2. Vaciamos la tabla de consumos para que el mensaje de WhatsApp no acumule registros antiguos
        await supabase.from('consumos').delete().eq('cliente_id', cliente.id);

        // 3. Ponemos la cuenta del cliente exactamente en 0
        await supabase.from('clientes').update({ deuda_usd: 0.00 }).eq('id', cliente.id);

        res.json({ mensaje: "Ciclo cerrado. Cliente solvente.", nuevo_saldo_usd: 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// 5. MONITOR DE LA TASA OFICIAL (BCV)
// =========================================================================
app.get('/api/tasa', async (req, res) => {
    try {
        const { data } = await axios.get('https://www.bcv.org.ve/', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            timeout: 4000
        });
        const $ = cheerio.load(data);
        const tasaTexto = $('#dolar strong').text().trim();
        const tasaLimpia = parseFloat(tasaTexto.replace(/\./g, '').replace(',', '.'));
        res.json({ tasa: tasaLimpia, fuente: "BCV Oficial" });
    } catch (e) {
        // Fallback estable si la página del gobierno experimenta latencia o caídas
        res.json({ tasa: 45.65, fuente: "BCV (Respaldo Fuera de Línea)" });
    }
});

app.listen(5000, () => console.log('🚀 Backend actualizado corriendo en puerto 5000'));