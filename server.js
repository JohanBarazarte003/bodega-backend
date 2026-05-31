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

// Obtener TODOS los clientes registrados
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

// Crear un nuevo cliente
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

// Eliminar un cliente de la base de datos
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

// Editar precio de un producto existente
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

// Eliminar un producto del inventario
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

        const { data: cData } = await supabase.from('clientes').select('*').eq('id', cliente_id);
        const { data: pData } = await supabase.from('productos').select('*').eq('id', producto_id);

        if (!cData?.length || !pData?.length) return res.status(404).json({ error: "Registros no encontrados" });

        const cliente = cData[0];
        const producto = pData[0];
        const subtotal = producto.precio_usd * cant;
        const nuevaDeuda = parseFloat(cliente.deuda_usd || 0) + subtotal;

        await supabase.from('consumos').insert([{
            cliente_id: cliente.id, cliente_nombre: cliente.nombre,
            producto: producto.nombre, cantidad: cant,
            precio_unitario_usd: producto.precio_usd, subtotal_usd: subtotal
        }]);

        await supabase.from('clientes').update({ deuda_usd: nuevaDeuda }).eq('id', cliente.id);
        res.json({ mensaje: "Consumo cargado", saldo: nuevaDeuda });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// =========================================================================
// 4.1 NUEVA RUTA: Obtener lo que debe un cliente específico
// =========================================================================
app.get('/api/consumos/:cliente_id', async (req, res) => {
    try {
        const { cliente_id } = req.params;
        const { data, error } = await supabase
            .from('consumos')
            .select('*')
            .eq('cliente_id', cliente_id)
            .order('created_at', { ascending: false }); // Lo más nuevo arriba

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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
            abonoUsd = montoInput / tasaDia; 
        } else {
            abonoUsd = montoInput;
            abonoBs = montoInput * tasaDia;  
        }
        
        let nuevaDeuda = deudaActual - abonoUsd;
        if (nuevaDeuda < 0.01) nuevaDeuda = 0; 

        await supabase.from('pagos').insert([{
            cliente_id: cliente.id,
            monto_usd: abonoUsd,
            monto_bs: abonoBs,
            tasa_usada: tasaDia,
            notes: `Abono registrado en ${moneda}`
        }]);

        await supabase.from('clientes').update({ deuda_usd: nuevaDeuda }).eq('id', cliente.id);

        res.json({ mensaje: "Pago registrado con éxito", nuevo_saldo_usd: nuevaDeuda });
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
            headers: { 'User-Agent': 'Mozilla/5.0' },
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            timeout: 3000
        });
        const $ = cheerio.load(data);
        const tasaTexto = $('#dolar strong').text().trim();
        const tasaLimpia = parseFloat(tasaTexto.replace('.', '').replace(',', '.'));
        res.json({ tasa: tasaLimpia, fuente: "BCV Oficial" });
    } catch (e) {
        res.json({ tasa: 45.65, fuente: "BCV (Respaldo Fuera de Línea)" });
    }
});

app.listen(5000, () => console.log('🚀 Backend actualizado corriendo en puerto 5000'));